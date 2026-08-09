/* Rift Atlas Stats Tracker - live DOM recorder.
 *
 * Drives the vendored rrweb recorder (global `rrwebRecord`) behind
 * `capture/capture-policy.js`, buffers the event stream and ships it to the
 * service worker. Exposes `globalThis.RATRec` = start/mark/stop/stats.
 *
 * The extension's premise is that it never interferes with play, so every entry
 * point and the rrweb `emit` callback is wrapped: an unexpected error tears down
 * the visual track only and leaves the structured tracker untouched. */
(function (root) {
  "use strict";

  const SETTLE_MS = 250; // quiet period after a sequence bump before we serialize
  const FLUSH_MS = 5000;
  const FLUSH_BYTES = 256 * 1024;
  const IDLE_TIMEOUT_MS = 1000; // never let an idle callback starve behind animation
  const FULL_SNAPSHOT = 2; // rrweb EventType.FullSnapshot
  const MAX_SAMPLES = 500; // capture-duration ring for the diagnostics p50
  const BLOCK_SELECTOR = ".ra-tracker-toast,#ra-tracker-banner";
  // Stop reasons the recorder raises itself, i.e. the match outran the capture.
  // Any other reason comes from `endMatch` and covers the match in full.
  const TRUNCATING = { budget: true, "perf-kill": true, error: true, restart: true };

  const hasIdle = typeof root.requestIdleCallback === "function";
  const idle = (fn) => (hasIdle ? root.requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS }) : setTimeout(fn, 0));
  const cancelIdle = (id) => (hasIdle ? root.cancelIdleCallback(id) : clearTimeout(id));
  const round1 = (n) => Math.round(n * 10) / 10;

  let session = null; // survives teardown so `stats()` can still report the match

  function send(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, (reply) => {
        // Reading lastError suppresses the "unchecked runtime.lastError" noise when
        // the worker is asleep; a lost batch only makes the replay incomplete.
        if (cb) cb(chrome.runtime.lastError ? null : reply);
      });
    } catch (_) { /* extension context invalidated mid-match: stay silent */ }
  }

  function flush(s) {
    if (!s.stopped) armFlush(s);
    if (!s.buffer.length) return;
    const events = s.buffer;
    const rawBytes = s.bufferBytes;
    s.buffer = [];
    s.bufferBytes = 0;
    send({ type: "ra:visual:events", matchId: s.matchId, events, rawBytes }, (reply) => {
      if (!reply || typeof reply.totalCompressedBytes !== "number") return;
      // The worker owns the byte total; we only ever mirror it.
      s.flushedBytes = reply.totalCompressedBytes;
      s.policy.onBytes(reply.totalCompressedBytes);
      checkPolicy(s);
    });
  }

  // Self-rearming rather than an interval, so a size-triggered flush also restarts
  // the 5s clock: a batch closes at 256KB *or* 5s, whichever comes first.
  function armFlush(s) {
    clearTimeout(s.flushTimer);
    s.flushTimer = setTimeout(() => guarded(() => { if (!s.stopped) flush(s); }), FLUSH_MS);
  }

  function onEmit(s, event) {
    const bytes = JSON.stringify(event).length;
    s.events += 1;
    s.buffer.push(event);
    s.bufferBytes += bytes;
    // A keyframe resets the ratio rule: the deltas that follow are measured against it.
    if (event && event.type === FULL_SNAPSHOT) {
      s.keyframes += 1;
      s.lastKeyframeBytes = bytes;
      s.bytesSinceKeyframe = 0;
    } else {
      s.bytesSinceKeyframe += bytes;
      s.deltaBytes += bytes; // diagnostics: keyframes are sized separately
    }
    if (s.bufferBytes >= FLUSH_BYTES) flush(s);
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

  function fire(s) {
    if (s.stopped || !s.stopRecording) return;
    const t0 = performance.now();
    // "turn" only when the turn actually moved; otherwise the ratio rule decides.
    const reason = s.pendingTurn !== s.lastKeyframeTurn ? "turn" : "ratio";
    const { pendingTurn: turnNumber, bytesSinceKeyframe, lastKeyframeBytes } = s;
    if (s.policy.shouldKeyframe({ reason, turnNumber, bytesSinceKeyframe, lastKeyframeBytes })) {
      s.lastKeyframeTurn = s.pendingTurn;
      root.rrwebRecord.takeFullSnapshot();
    }
    const ms = performance.now() - t0;
    s.lastFrameAt = t0;
    s.captureMaxMs = Math.max(s.captureMaxMs, ms);
    if (s.samples.push(ms) > MAX_SAMPLES) s.samples.shift();
    s.policy.onCaptureDuration(ms); // may latch the kill switch
    checkPolicy(s);
  }

  function checkPolicy(s) {
    if (s.stopped) return;
    const st = s.policy.state();
    if (st === "stopped" || st === "killed") teardown(s, st === "stopped" ? "budget" : "perf-kill");
  }

  function teardown(s, reason) {
    if (s.stopped) return;
    s.stopped = true;
    s.stopReason = reason;
    clearTimeout(s.flushTimer);
    cancelSettle(s);
    try { if (s.stopRecording) s.stopRecording(); } catch (_) { /* rrweb already gone */ }
    s.stopRecording = null;
    // s.stopped is set, so this final flush cannot rearm the timer.
    try { flush(s); } catch (_) { /* a corrupt tail must not block the stop message */ }
    const truncatedAtTurn = TRUNCATING[reason] ? s.turnNumber : null;
    send({ type: "ra:visual:stop", matchId: s.matchId, reason, truncatedAtTurn, stats: reportableStats(s) });
  }

  function guarded(fn) {
    try {
      return fn();
    } catch (err) { // the visual track dies here and nowhere else
      try {
        console.warn("[Rift Atlas] visual capture stopped:", err);
        if (session) teardown(session, "error");
      } catch (_) { /* never throw into the page */ }
    }
  }

  function snapshotStats(s) {
    if (!s) return { matchId: null, state: "idle", events: 0, keyframes: 0, meanDeltaBytes: 0, flushedBytes: 0, captureP50Ms: 0, captureMaxMs: 0, usedRatio: 0 };
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
    };
  }

  function beginRecording(s, budgetMb) {
    s.policy = root.createCapturePolicy({ budgetBytes: Math.max(1, Number(budgetMb) || 8) * 1024 * 1024 });
    const meta = { viewport: s.viewport, startedAt: s.startedAt, href: location.href };
    send({ type: "ra:visual:start", matchId: s.matchId, meta }); // viewport sizes the viewer's iframe
    s.stopRecording = root.rrwebRecord.record({
      emit: (event) => guarded(() => onEmit(s, event)),
      blockSelector: BLOCK_SELECTOR, // our own injected UI, never the game's
      maskInputOptions: { text: true, password: true },
      inlineStylesheet: true,
      recordCanvas: false,
      collectFonts: false,
      // Pointer noise is worthless for a card game and dominates the byte budget.
      sampling: { mousemove: false, mouseInteraction: false, scroll: 1000, input: "last" },
    });
    armFlush(s);
  }

  root.RATRec = {
    start(matchId) {
      return guarded(() => {
        // A new match always starts from a clean session; the old one is closed out.
        if (session && !session.stopped) teardown(session, "restart");
        if (typeof root.rrwebRecord === "undefined" || typeof root.createCapturePolicy !== "function") return;
        const s = (session = {
          matchId, startedAt: Date.now(),
          viewport: { w: root.innerWidth, h: root.innerHeight, dpr: root.devicePixelRatio || 1 },
          policy: null, stopRecording: null, stopped: false, stopReason: null,
          buffer: [], bufferBytes: 0, flushTimer: null, flushedBytes: 0,
          idleId: null, settleId: null, pendingTurn: null, turnNumber: null,
          lastKeyframeTurn: null, lastKeyframeBytes: 0, bytesSinceKeyframe: 0, lastFrameAt: -Infinity,
          events: 0, keyframes: 0, deltaBytes: 0, samples: [], captureMaxMs: 0,
        });
        chrome.storage.local.get({ settings: {} }, (data) => guarded(() => {
          const cfg = (data && data.settings) || {}; // visualReplayEnabled defaults true
          // A stop() landing before storage answers must not start rrweb after all.
          if (cfg.visualReplayEnabled === false || s.stopped || session !== s) return;
          beginRecording(s, cfg.visualReplayBudgetMb);
        }));
      });
    },
    // `seq` only says "something authoritative changed"; the turn drives keyframes.
    mark(seq, turnNumber) {
      return guarded(() => {
        const s = session;
        if (!s || s.stopped || !s.stopRecording) return;
        s.turnNumber = turnNumber;
        // Coalescing drops the mark outright rather than restarting the settle,
        // so a burst of bumps still yields one frame per minFrameIntervalMs.
        const minGap = s.policy.minFrameIntervalMs();
        if (minGap > 0 && performance.now() - s.lastFrameAt < minGap) return;
        s.pendingTurn = turnNumber;
        scheduleSettle(s);
      });
    },
    stop(reason) {
      return guarded(() => { if (session && !session.stopped) teardown(session, reason || "end"); });
    },
    stats() {
      try { return snapshotStats(session); } catch (_) { return snapshotStats(null); }
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
