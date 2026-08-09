/* Rift Atlas Stats Tracker - live DOM recorder.
 *
 * Drives the vendored rrweb recorder (global `rrwebRecord`) behind
 * `capture/capture-policy.js`, buffers the event stream and ships it to the
 * service worker. Exposes `globalThis.RATRec` = start/mark/stop/stats.
 *
 * The extension's premise is that it never interferes with play, so every entry
 * point and the rrweb `emit` callback is wrapped: an unexpected error ends the
 * recording and nothing else. The match record, its game log, its result and its
 * card list are produced by content.js and run to the end of the match either
 * way; only the replay stops, and the viewer says which turns it covers. */
(function (root) {
  "use strict";

  const SETTLE_MS = 250; // quiet period after a sequence bump before we serialize
  const FLUSH_MS = 5000;
  const FLUSH_BYTES = 256 * 1024;
  // A batch the worker never confirmed is held for a retry; past this much
  // buffered data we start dropping the oldest rather than growing without end.
  const MAX_RETAINED_BYTES = 2 * FLUSH_BYTES;
  const MAX_FLUSH_FAILURES = 3; // consecutive; then the visual track gives up loudly
  const IDLE_TIMEOUT_MS = 1000; // never let an idle callback starve behind animation
  const FULL_SNAPSHOT = 2; // rrweb EventType.FullSnapshot
  const MAX_SAMPLES = 500; // capture-duration ring for the diagnostics p50
  // A full snapshot is never serialized on this thread just to size it (that is
  // the single most expensive thing the page could do), so it enters the buffer
  // at a nominal weight purely to keep the flush and retry bounds meaningful.
  // The worker's compressed total is the only figure anything decides on.
  const SNAPSHOT_WEIGHT_BYTES = 64 * 1024;
  const BLOCK_SELECTOR = ".ra-tracker-toast,#ra-tracker-banner";
  // Runaway guard only, and deliberately far above what a match costs. Storage
  // is bounded by retention instead, so this exists to catch a pathological
  // recording rather than to shape a normal one.
  const DEFAULT_MAX_MATCH_MB = 512;
  // Stop reasons the recorder raises itself, i.e. the match outran the capture.
  // Any other reason comes from `endMatch` and covers the match in full.
  const TRUNCATING = { budget: true, "perf-kill": true, error: true, restart: true };

  const hasIdle = typeof root.requestIdleCallback === "function";
  const idle = (fn) => (hasIdle ? root.requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS }) : setTimeout(fn, 0));
  const cancelIdle = (id) => (hasIdle ? root.cancelIdleCallback(id) : clearTimeout(id));
  const round1 = (n) => Math.round(n * 10) / 10;
  const encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;

  let session = null; // survives teardown so `stats()` can still report the match

  function send(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, (reply) => {
        // Reading lastError suppresses the "unchecked runtime.lastError" noise
        // when the worker is asleep; the caller decides what a miss costs.
        if (cb) cb(chrome.runtime.lastError ? null : reply);
      });
    } catch (_) {
      // Extension context invalidated mid-match: stay silent towards the page,
      // but the caller still has to learn its batch never landed.
      if (cb) cb(null);
    }
  }

  /* Approximate size of one delta event, in UTF-8 bytes. Only ever called for
   * deltas: they are small, and their sizes are what the diagnostics report. */
  function approxDeltaBytes(event) {
    try {
      const json = JSON.stringify(event);
      if (!json) return 0;
      return encoder ? encoder.encode(json).length : json.length;
    } catch (_) {
      return 0;
    }
  }

  function flush(s, force) {
    if (!s.stopped) armFlush(s);
    if (!s.buffer.length) return;
    // One batch in flight at a time: a retry prepends its events back, so an
    // overlapping second batch could reorder the stream. rrweb cannot recover
    // from that. The stopping flush goes out regardless - it is the last one.
    if (s.inFlight && !force) return;

    const events = s.buffer;
    const rawBytes = s.bufferBytes;
    const hadKeyframe = s.bufferHasKeyframe;
    s.buffer = [];
    s.bufferBytes = 0;
    s.bufferHasKeyframe = false;
    s.inFlight = true;
    send({ type: "ra:visual:events", matchId: s.matchId, events, rawBytes }, (reply) => {
      s.inFlight = false;
      if (reply && reply.ok !== false && Number.isFinite(Number(reply.totalCompressedBytes))) {
        s.flushFailures = 0;
        onFlushed(s, Number(reply.totalCompressedBytes), hadKeyframe);
      } else {
        onFlushFailed(s, events, rawBytes, hadKeyframe, reply);
      }
    });
  }

  function onFlushed(s, totalCompressedBytes, hadKeyframe) {
    // The worker owns the byte totals; we only ever mirror them. The growth one
    // flush caused is also the only authoritative size we have for the snapshot
    // that flush carried, which is what the ratio rule diffs against.
    const growth = Math.max(0, totalCompressedBytes - s.flushedBytes);
    s.flushedBytes = totalCompressedBytes;
    if (hadKeyframe) {
      s.lastKeyframeBytes = growth;
      s.bytesSinceKeyframe = 0;
    } else {
      s.bytesSinceKeyframe += growth;
    }
    s.policy.onBytes(totalCompressedBytes);
    checkPolicy(s);
  }

  /* A batch is only ours to forget once the worker says it landed. The first
   * batch carries rrweb's opening full snapshot: without it the stored stream is
   * a delta chain with nothing to apply against, i.e. unplayable rather than
   * merely short. So failures go back on the front of the buffer, and a worker
   * that keeps refusing ends the visual track with a diagnosable error. */
  function onFlushFailed(s, events, rawBytes, hadKeyframe, reply) {
    s.flushFailures += 1;
    if (!s.stopped) {
      if (s.bufferBytes + rawBytes > MAX_RETAINED_BYTES) {
        s.droppedEvents += events.length;
      } else {
        s.buffer = events.concat(s.buffer); // order is load-bearing
        s.bufferBytes += rawBytes;
        s.bufferHasKeyframe = s.bufferHasKeyframe || hadKeyframe;
      }
    }
    if (s.flushFailures >= MAX_FLUSH_FAILURES) {
      const why = (reply && reply.error) ||
        "visual events rejected " + s.flushFailures + " times in a row";
      teardown(s, "error", why);
    }
  }

  // Self-rearming rather than an interval, so a size-triggered flush also restarts
  // the 5s clock: a batch closes at 256KB *or* 5s, whichever comes first.
  function armFlush(s) {
    clearTimeout(s.flushTimer);
    s.flushTimer = setTimeout(() => guarded(() => { if (!s.stopped) flush(s); }), FLUSH_MS);
  }

  /* Buffers one rrweb event and reports whether the batch should close now.
   * Deliberately does no flushing itself: the caller times this function as the
   * per-change capture cost, and shipping a batch is not that cost. */
  function onEmit(s, event) {
    const isKeyframe = !!event && event.type === FULL_SNAPSHOT;
    s.events += 1;
    s.buffer.push(event);
    if (isKeyframe) {
      s.keyframes += 1;
      s.bufferHasKeyframe = true;
      s.bufferBytes += SNAPSHOT_WEIGHT_BYTES;
      // Ship it straight away: the sooner it lands the sooner the worker tells
      // us what it actually cost, which is what the ratio rule needs.
      return true;
    }
    const bytes = approxDeltaBytes(event);
    s.bufferBytes += bytes;
    s.deltaBytes += bytes; // diagnostics: keyframes are sized by the worker
    return s.bufferBytes >= FLUSH_BYTES;
  }

  /* Every millisecond we spend on the page's own thread, snapshot or not. The
   * kill switch exists to catch a page stuttering under continuous capture, so
   * it has to see the continuous work and not only the explicit snapshots.
   * The p50 stays snapshot-only: it is reported as the cost of a frame. */
  function noteCaptureCost(s, ms, isSnapshot) {
    s.captureMaxMs = Math.max(s.captureMaxMs, ms);
    if (isSnapshot && s.samples.push(ms) > MAX_SAMPLES) s.samples.shift();
    s.policy.onCaptureDuration(ms); // may latch the kill switch
    checkPolicy(s);
  }

  function cancelSettle(s) {
    if (s.idleId !== null) cancelIdle(s.idleId);
    if (s.settleId !== null) clearTimeout(s.settleId);
    s.idleId = s.settleId = null;
  }

  // requestIdleCallback puts us after the frame's own work; the 250ms timer then
  // waits out card animations so we never serialize a half-transitioned board.
  function scheduleSettle(s) {
    cancelSettle(s);
    s.idleId = idle(() => {
      s.idleId = null;
      s.settleId = setTimeout(() => { s.settleId = null; guarded(() => fire(s)); }, SETTLE_MS);
    });
  }

  /* The viewer builds its chapter chips from these markers. Without them it
   * falls back to numbering full snapshots, and since the ratio rule takes
   * snapshots of its own that numbering is not the turn number at all. */
  function tagTurn(s, turnNumber) {
    if (turnNumber === null || turnNumber === undefined) return;
    const n = Number(turnNumber);
    if (!Number.isFinite(n)) return;
    if (typeof root.rrwebRecord.addCustomEvent !== "function") return;
    root.rrwebRecord.addCustomEvent("ra:turn", { turnNumber: n });
  }

  function keyframe(s, turnNumber) {
    const t0 = performance.now();
    s.lastKeyframeTurn = turnNumber;
    tagTurn(s, turnNumber);
    root.rrwebRecord.takeFullSnapshot();
    noteCaptureCost(s, performance.now() - t0, true);
  }

  function fire(s) {
    if (s.stopped || s.finishing || !s.stopRecording) return;
    // "turn" only when the turn actually moved; otherwise the ratio rule decides.
    const reason = s.pendingTurn !== s.lastKeyframeTurn ? "turn" : "ratio";
    const { pendingTurn: turnNumber, bytesSinceKeyframe, lastKeyframeBytes } = s;
    if (!s.policy.shouldKeyframe({ reason, turnNumber, bytesSinceKeyframe, lastKeyframeBytes })) return;
    keyframe(s, turnNumber);
  }

  // Not while finishing: the match is already over, so back-pressure has nothing
  // left to save and would only relabel a complete recording as truncated.
  function checkPolicy(s) {
    if (s.stopped || s.finishing) return;
    const st = s.policy.state();
    if (st === "stopped" || st === "killed") teardown(s, st === "stopped" ? "budget" : "perf-kill");
  }

  /* The site renders the victory/defeat modal *after* the score DOM crosses the
   * win threshold, and that modal is the single most important frame of the
   * match. So an "end" stop lets rrweb run one more settle interval, takes a
   * final frame and only then tears down. The window is short but it is real:
   * a tab close or a new match during it must still close the recording out. */
  function finishAfterSettle(s) {
    if (s.finishing) return;
    s.finishing = true;
    cancelSettle(s); // no competing frame while we wait for the modal
    if (typeof root.addEventListener === "function") {
      s.onPageHide = () => guarded(() => teardown(s, "end"));
      root.addEventListener("pagehide", s.onPageHide);
    }
    s.finishTimer = setTimeout(() => guarded(() => finalFrame(s)), SETTLE_MS);
  }

  function detachPageHide(s) {
    if (s.onPageHide && typeof root.removeEventListener === "function") {
      root.removeEventListener("pagehide", s.onPageHide);
    }
    s.onPageHide = null;
  }

  function finalFrame(s) {
    s.finishTimer = null;
    if (s.stopped) return;
    const st = s.policy.state();
    if (s.stopRecording && st !== "stopped" && st !== "killed") keyframe(s, s.turnNumber);
    teardown(s, "end");
  }

  function teardown(s, reason, err) {
    if (s.stopped) return;
    s.stopped = true;
    s.finishing = false;
    s.stopReason = reason;
    clearTimeout(s.flushTimer);
    clearTimeout(s.finishTimer);
    s.finishTimer = null;
    detachPageHide(s);
    cancelSettle(s);
    try { if (s.stopRecording) s.stopRecording(); } catch (_) { /* rrweb already gone */ }
    s.stopRecording = null;
    // s.stopped is set, so this final flush cannot rearm the timer, and a batch
    // that fails now is not worth retrying into a session that is closing.
    try { flush(s, true); } catch (_) { /* a corrupt tail must not block the stop message */ }
    const truncatedAtTurn = TRUNCATING[reason] ? s.turnNumber : null;
    const error = err === null || err === undefined ? null : String((err && err.message) || err);
    send({
      type: "ra:visual:stop",
      matchId: s.matchId,
      reason,
      truncatedAtTurn,
      error,
      stats: reportableStats(s),
    });
  }

  function guarded(fn) {
    try {
      return fn();
    } catch (err) { // the visual track dies here and nowhere else
      try {
        console.warn("[Rift Atlas] visual capture stopped:", err);
        if (session) teardown(session, "error", err);
      } catch (_) { /* never throw into the page */ }
    }
  }

  function snapshotStats(s) {
    if (!s) {
      return {
        matchId: null, state: "idle", events: 0, keyframes: 0, meanDeltaBytes: 0,
        flushedBytes: 0, captureP50Ms: 0, captureMaxMs: 0, usedRatio: 0, droppedEvents: 0,
      };
    }
    const sorted = s.samples.slice().sort((a, b) => a - b);
    const deltas = Math.max(0, s.events - s.keyframes);
    return {
      matchId: s.matchId,
      state: s.stopped ? s.stopReason || "stopped" : s.policy ? s.policy.state() : "starting",
      events: s.events, keyframes: s.keyframes, flushedBytes: s.flushedBytes,
      meanDeltaBytes: deltas ? Math.round(s.deltaBytes / deltas) : 0,
      captureP50Ms: sorted.length ? round1(sorted[sorted.length >> 1]) : 0,
      captureMaxMs: round1(s.captureMaxMs),
      usedRatio: s.policy ? s.policy.usedRatio() : 0,
      droppedEvents: s.droppedEvents,
    };
  }

  // What the diagnostics panel can only learn from this side of the wire:
  // frame timings and the keyframe/delta split live in the page, not the store.
  function reportableStats(s) {
    const snap = snapshotStats(s);
    return {
      keyframes: snap.keyframes,
      meanDeltaBytes: snap.meanDeltaBytes,
      captureP50Ms: snap.captureP50Ms,
      captureMaxMs: snap.captureMaxMs,
      droppedEvents: snap.droppedEvents,
    };
  }

  function beginRecording(s, maxMatchMb) {
    // An unset setting falls back to the default ceiling; an explicit 0 or a
    // blank field is "no ceiling", which the policy reads off a non-positive
    // budget. Only a real number here may lower the guard.
    const mb = Number(maxMatchMb);
    const ceilingMb = Number.isFinite(mb) ? mb : DEFAULT_MAX_MATCH_MB;
    s.policy = root.createCapturePolicy({ budgetBytes: ceilingMb * 1024 * 1024 });
    const meta = { viewport: s.viewport, startedAt: s.startedAt, href: location.href };
    send({ type: "ra:visual:start", matchId: s.matchId, meta }); // viewport sizes the viewer's iframe
    // The record-only bundle exposes the record function AS `rrwebRecord`, with
    // takeFullSnapshot/addCustomEvent hung off it. Only the all-in-one `rrweb`
    // bundle has a `.record` member; calling that here is what broke capture.
    const stopRecording = root.rrwebRecord({
      // rrweb calls this synchronously out of its own serialization, so the time
      // spent here is time the game's thread does not have. Timed, then flushed.
      emit: (event) => guarded(() => {
        const t0 = performance.now();
        const full = onEmit(s, event);
        noteCaptureCost(s, performance.now() - t0, false);
        if (full && !s.stopped) flush(s);
      }),
      blockSelector: BLOCK_SELECTOR, // our own injected UI, never the game's
      maskInputOptions: { text: true, password: true },
      inlineStylesheet: true,
      recordCanvas: false,
      collectFonts: false,
      // Pointer noise is worthless for a card game and dominates the byte budget.
      sampling: { mousemove: false, mouseInteraction: false, scroll: 1000, input: "last" },
    });
    // rrweb takes its opening snapshot inside `record()`, so `emit` - and with it
    // a kill-switch teardown - can fire before this call even returns. Handing
    // the stop function over only now would leave rrweb running for good.
    if (s.stopped) {
      try { if (stopRecording) stopRecording(); } catch (_) { /* rrweb already gone */ }
      return;
    }
    s.stopRecording = stopRecording;
    armFlush(s);
  }

  root.RATRec = {
    start(matchId) {
      return guarded(() => {
        // A new match always starts from a clean session; the old one is closed out.
        if (session && !session.stopped) teardown(session, "restart");
        // A start we cannot honour still clears the old session: otherwise the
        // previous match's stopped session lingers and `stats()` reports it.
        session = null;
        if (typeof root.rrwebRecord !== "function" || typeof root.createCapturePolicy !== "function") return;
        const s = (session = {
          matchId, startedAt: Date.now(),
          viewport: { w: root.innerWidth, h: root.innerHeight, dpr: root.devicePixelRatio || 1 },
          policy: null, stopRecording: null, stopped: false, stopReason: null,
          buffer: [], bufferBytes: 0, bufferHasKeyframe: false, flushTimer: null, flushedBytes: 0,
          inFlight: false, flushFailures: 0, droppedEvents: 0,
          idleId: null, settleId: null, pendingTurn: null, turnNumber: null,
          finishing: false, finishTimer: null, onPageHide: null,
          lastKeyframeTurn: null, lastKeyframeBytes: 0, bytesSinceKeyframe: 0,
          events: 0, keyframes: 0, deltaBytes: 0, samples: [], captureMaxMs: 0,
        });
        chrome.storage.local.get({ settings: {} }, (data) => guarded(() => {
          const cfg = (data && data.settings) || {}; // visualReplayEnabled defaults true
          // A stop() landing before storage answers must not start rrweb after all.
          if (cfg.visualReplayEnabled === false || s.stopped || session !== s) return;
          beginRecording(s, cfg.visualReplayMaxMatchMb);
        }));
      });
    },
    mark(turnNumber) {
      return guarded(() => {
        const s = session;
        if (!s || s.stopped || s.finishing || !s.stopRecording) return;
        s.turnNumber = turnNumber;
        // Every mark is honoured: capture runs at full fidelity or not at all,
        // so there is no throttle here to drop one.
        s.pendingTurn = turnNumber;
        scheduleSettle(s);
      });
    },
    stop(reason) {
      return guarded(() => {
        const s = session;
        if (!s || s.stopped) return;
        const why = reason || "end";
        if (why === "end" && s.stopRecording) finishAfterSettle(s);
        else teardown(s, why);
      });
    },
    stats() {
      try { return snapshotStats(session); } catch (_) { return snapshotStats(null); }
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
