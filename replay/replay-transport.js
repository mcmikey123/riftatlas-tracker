/* Rift Atlas Stats Tracker - the shared transport row
 *
 * The controls that sit under a replay on every surface: play, step, seek, the
 * clock, which chapter chip is lit, and the keyboard. The dashboard modal and
 * the standalone share viewer draw different chrome around a replay - one is a
 * modal with fullscreen and a share button, the other is a whole page - but the
 * row itself is the same row, and until this file it was a copy in each of them.
 *
 * It had already drifted twice: the dashboard's space shortcut knew only `" "`
 * where the guard it calls one line earlier knows `"Spacebar"` too, so on an
 * engine reporting the older name the key silently did nothing; and only one of
 * the two kept the play button's accessible name in step with its glyph. Both
 * are fixed here, once. `targetOwnsKey` in replay-timeline.js carries the same
 * story - four drifts before it was extracted - which is why the transport
 * follows it out rather than waiting for a third.
 *
 * The chrome keeps its own markup, its own extra controls and its own answer
 * for a recording that will not play; it hands in the elements and gets a
 * wired-up transport back. Everything decidable from data alone - the key map,
 * the active-chip rule, what one paint puts on the slider and the clock - is
 * pure and covered by test/replay-transport.test.js. The rest is
 * addEventListener, which gets no unit tests by project convention.
 */
(function (root) {
  "use strict";

  const PLAY_GLYPH = "▶";
  const PAUSE_GLYPH = "❚❚";

  /**
   * The chip the transport is standing on: the last one at or before `at`, or
   * -1 before the first chip.
   *
   * The millisecond of slack is what keeps a chip lit on the seek that was
   * aimed at it - the position handed back after a seek is the engine's, and it
   * is not obliged to be the exact number the chip asked for.
   */
  function activeChip(chips, at) {
    let active = -1;
    if (!chips) return active;
    chips.forEach((chip, n) => {
      if (chip.ms <= at + 1) active = n;
    });
    return active;
  }

  /**
   * Everything one paint puts on screen, from the position alone.
   *
   * The slider's range is part of every paint rather than something set once
   * after the transport starts: the core fires its first `onTime` from inside
   * create(), before any caller holds a controller to ask how long the
   * recording is, and a slider still carrying the markup's default would put
   * that first position at the wrong place on the track.
   *
   * `fmtClock` is passed in because the two surfaces already have one and they
   * are not the same function - the extension's lives in dashboard/format.js
   * and the viewer's in share/viewer-support.js.
   */
  function readout(at, total, chips, fmtClock) {
    return {
      max: String(Math.round(total)),
      value: String(Math.round(at)),
      clock: fmtClock(at) + " / " + fmtClock(total),
      active: activeChip(chips, at)
    };
  }

  /**
   * The play button's face at a given transport state.
   *
   * The label is not decoration. The glyphs are a triangle and two bars, which
   * a screen reader either spells out or skips, so the button's accessible name
   * has to move with them; one surface did that and the other left the reader
   * with whatever the title said, permanently claiming "play" while the replay
   * was playing.
   */
  function playFace(playing) {
    return {
      text: playing ? PAUSE_GLYPH : PLAY_GLYPH,
      label: playing ? "Pause" : "Play"
    };
  }

  /**
   * The keys both surfaces answer, and what each one asks the transport to do.
   *
   * "Spacebar" is the older name for the space key, still reported by some
   * engines, and `targetOwnsKey` has always known both spellings - so a map
   * that knew only `" "` disagreed with the guard called immediately before it.
   *
   * Null-prototype: `e.key` is whatever the platform hands over, and a lookup
   * on a plain object would answer "constructor" and "toString" with something
   * truthy that is not an action.
   */
  const KEY_ACTIONS = Object.freeze(
    Object.assign(Object.create(null), {
      " ": "play",
      Spacebar: "play",
      ArrowLeft: "prev",
      ArrowRight: "next",
      Home: "first",
      End: "last"
    })
  );

  /**
   * Which transport action a keypress asks for, or null for one the transport
   * has no business taking - either an unmapped key, or a key the focused
   * element owns itself.
   *
   * A chrome with shortcuts of its own (the modal's Escape and f) handles those
   * around this call and guards them the same way; only the keys both surfaces
   * share live here.
   */
  function keyAction(key, target) {
    if (root.RAReplayTimeline.targetOwnsKey(target, key)) return null;
    return KEY_ACTIONS[key] || null;
  }

  /** Do `action` to the transport. The table both surfaces used to keep twice. */
  function runAction(action, playback) {
    const { SEEK } = root.RAReplayTimeline;
    switch (action) {
      case "play":
        return playback.togglePlay();
      case "prev":
        return playback.stepTo(-1);
      case "next":
        return playback.stepTo(1);
      case "first":
        return playback.seek(0, SEEK.JUMP);
      case "last":
        return playback.seek(playback.totalTime, SEEK.JUMP);
      default:
        return undefined;
    }
  }

  /**
   * Handle a keydown, and say whether the transport took it. A chrome that has
   * more keys of its own carries on when this answers false.
   */
  function handleKey(event, playback) {
    if (!playback) return false;
    const action = keyAction(event.key, event.target);
    if (!action) return false;
    event.preventDefault();
    runAction(action, playback);
    return true;
  }

  /**
   * Start a transport with the row's own painters and wire the row to it.
   *
   *   wireTransport({ create, chips, fmtClock, els }) -> playback | null
   *
   * `create(callbacks)` is the chrome's own call to `RAReplayCore.create` with
   * `onTime` and `onPlayState` filled in. The call is inverted like that
   * because the ordering is the whole point and is easy to get wrong: the
   * painters have to exist before create(), which fires both of them from
   * inside itself, and no control can be wired until create() has handed back
   * something to wire it to. A chrome given the painters to pass on itself
   * would be free to drop that first paint, and the first paint is the one that
   * sizes the slider.
   *
   * `els` are the chrome's own elements, whatever it calls them in its markup:
   * `play`, `prev`, `next`, `slider`, `clock`, `chapterEls` (the chips, in
   * `chips` order) and `chapterHost` (whichever ancestor their clicks are
   * delegated on - the surfaces differ, one delegating on the chip row and the
   * other on the whole viewer). `speed` is optional, for a chrome that draws
   * the playback-rate control; a chrome without one keeps the core's 1x.
   *
   * Null comes back when the recording will not play. What to say about that is
   * the chrome's business and the two surfaces say quite different things.
   */
  function wireTransport(config) {
    const els = config.els;
    const chips = config.chips || [];
    const chapterEls = els.chapterEls || [];
    const fmtClock = config.fmtClock;

    function paintTime(at, total) {
      const next = readout(at, total, chips, fmtClock);
      els.slider.max = next.max;
      els.slider.value = next.value;
      els.clock.textContent = next.clock;
      chapterEls.forEach((el, n) => el.classList.toggle("on", n === next.active));
    }

    function paintPlayState(playing) {
      const face = playFace(playing);
      els.play.textContent = face.text;
      els.play.setAttribute("aria-label", face.label);
    }

    const playback = config.create({ onTime: paintTime, onPlayState: paintPlayState });
    if (!playback) return null;

    const { SEEK } = root.RAReplayTimeline;
    els.play.addEventListener("click", () => playback.togglePlay());
    els.prev.addEventListener("click", () => playback.stepTo(-1));
    els.next.addEventListener("click", () => playback.stepTo(1));
    // `input` fires all the way through a drag, so the drag holds playback and
    // the end of the drag is what puts it back. The end is taken from the events
    // that always fire — never from `change`, which Gecko withholds when the
    // value lands back where the interaction started it.
    els.slider.addEventListener("input", () =>
      playback.seek(parseInt(els.slider.value, 10) || 0, SEEK.DRAG)
    );
    for (const type of root.RAReplayCore.DRAG_END_EVENTS) {
      els.slider.addEventListener(type, playback.endDrag);
    }
    els.chapterHost.addEventListener("click", (e) => {
      const ms = e.target && e.target.dataset ? e.target.dataset.ms : undefined;
      if (ms !== undefined) playback.seek(parseInt(ms, 10) || 0, SEEK.CHAPTER);
    });
    /* The control is written back from what the core ACCEPTED, not from what
     * it was handed: the core owns what a readable speed is, and a select left
     * showing a rate the engine refused would be the control lying about the
     * replay underneath it. Both surfaces only offer valid speeds today, so
     * the write-back is invisible - which is exactly why it belongs here and
     * not in two chromes free to drift on it. */
    if (els.speed) {
      els.speed.addEventListener("change", () => {
        els.speed.value = String(playback.setSpeed(parseFloat(els.speed.value)));
      });
    }

    return playback;
  }

  // Same dual export as replay-timeline.js: a global for the browser, CommonJS
  // for `node --test`. The DOM-touching half is `wireTransport`; everything
  // above it is decidable from data and is what the tests hold.
  const api = {
    activeChip,
    readout,
    playFace,
    keyAction,
    handleKey,
    wireTransport
  };

  root.RAReplayTransport = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
