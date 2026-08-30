/* The recorder's turn/snapshot sequencing.
 *
 * This exists because the invariant it pins - exactly one `ra:turn` per turn -
 * is the kind that fails silently. A dropped tag costs a chapter chip; a
 * duplicated one adds a phantom, since replay-timeline.js pushes one mark per
 * marker and never dedupes. Neither throws, neither is logged, and neither
 * appears anywhere but a chip row the recorder cannot see. The codebase has
 * been wrong about it before, in both directions.
 *
 * Tagging and snapshotting were one operation until snapshots moved onto a time
 * cadence, and separating them is what makes the invariant non-obvious: a turn
 * that spends no snapshot must still be tagged, and the closing frame must not
 * re-tag a turn that already settled normally.
 *
 * dom-recorder.js is an IIFE over `globalThis` with no exports, so it is loaded
 * into a vm sandbox holding stubs for everything it reaches for. The capture
 * policy is the REAL one - the cadence under test lives there, and stubbing it
 * would only test this file's idea of it. Time is a fake clock: the recorder's
 * only scheduling primitives are setTimeout and requestIdleCallback, and it
 * degrades to setTimeout when the latter is absent, so one queue drives it all.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SETTLE_MS = 250; // must match dom-recorder.js
const FULL_SNAPSHOT = 2;
const INCREMENTAL_SNAPSHOT = 3;
const MOUSE_MOVE = 1; // rrweb IncrementalSource.MouseMove

const readSrc = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

/**
 * A recorder in a sandbox, with a clock the test drives.
 *
 * Returns the recorder plus the three things worth asserting on: the turn tags
 * in order, when snapshots were spent, and what reached the worker.
 */
function harness() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const tags = [];
  const snapshotsAt = [];
  const sent = [];
  const warnings = [];

  const sandbox = {
    console: {
      warn: (...args) => warnings.push(args.join(" ")),
      log() {},
      error: (...args) => warnings.push(args.join(" ")),
    },
    performance: { now: () => now },
    Date,
    TextEncoder,
    JSON,
    Math,
    Number,
    Array,
    location: { href: "https://example.test/game" },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + (Number(ms) || 0), fn });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    addEventListener() {},
    removeEventListener() {},
    chrome: {
      runtime: {
        lastError: null,
        // Always accepts, and reports a growing total so the policy's byte
        // guard never trips during these tests.
        sendMessage: (msg, cb) => {
          sent.push(msg);
          if (cb) cb({ ok: true, totalCompressedBytes: sent.length * 1024 });
        },
      },
      storage: { local: { get: (_defaults, cb) => cb({ settings: {} }) } },
    },
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  // Policy first: dom-recorder.js reads createCapturePolicy off the global.
  vm.runInContext(readSrc("capture/capture-policy.js"), context, { filename: "capture-policy.js" });

  let emit = () => {};
  let recordCfg = null;
  const rrwebRecord = (cfg) => {
    recordCfg = cfg;
    emit = cfg.emit;
    // rrweb takes its opening snapshot inside record(), before returning.
    emit({ type: FULL_SNAPSHOT, timestamp: now, data: {} });
    return function stopRecording() {};
  };
  rrwebRecord.takeFullSnapshot = () => {
    snapshotsAt.push(now);
    emit({ type: FULL_SNAPSHOT, timestamp: now, data: {} });
  };
  rrwebRecord.addCustomEvent = (tag, payload) => {
    tags.push({ tag, ...payload });
    emit({ type: 5, timestamp: now, data: { tag, payload } });
  };
  sandbox.rrwebRecord = rrwebRecord;

  vm.runInContext(readSrc("capture/dom-recorder.js"), context, { filename: "dom-recorder.js" });

  /** Advance the clock, running every timer that comes due, in order. */
  function advance(ms) {
    const target = now + ms;
    for (;;) {
      let nextId = null;
      let next = null;
      for (const [id, t] of timers) {
        if (t.at > target) continue;
        if (!next || t.at < next.at || (t.at === next.at && id < nextId)) {
          next = t;
          nextId = id;
        }
      }
      if (!next) break;
      timers.delete(nextId);
      now = Math.max(now, next.at);
      next.fn();
    }
    now = target;
  }

  return {
    rec: sandbox.RATRec,
    tags,
    snapshotsAt,
    sent,
    warnings,
    advance,
    /** A turn mark followed by the quiet period that lets it settle. */
    turn(n) {
      sandbox.RATRec.mark(n);
      advance(SETTLE_MS + 1);
    },
    turnNumbers: () => tags.filter((t) => t.tag === "ra:turn").map((t) => t.turnNumber),
    /** The options the recorder handed rrweb, once `start` has run. */
    config: () => recordCfg,
    /** Push one event through rrweb's emit, the way rrweb itself would. */
    emit: (event) => emit(event),
  };
}

const mouseMove = (now) => ({
  type: INCREMENTAL_SNAPSHOT,
  timestamp: now,
  data: { source: MOUSE_MOVE, positions: [{ x: 10, y: 20, id: 7, timeOffset: -50 }] },
});

test("the sandbox drives a real recording end to end", () => {
  // Guard on the harness itself: every later assertion is meaningless if the
  // recorder silently tore down, and `guarded` swallows into console.warn.
  const h = harness();
  h.rec.start("m1");
  h.turn(1);
  h.rec.stop("end");
  h.advance(SETTLE_MS + 1);

  assert.deepEqual(h.warnings, [], "the recorder must not have errored");
  assert.ok(
    h.sent.some((m) => m.type === "ra:visual:start"),
    "recording must have started"
  );
  assert.ok(
    h.sent.some((m) => m.type === "ra:visual:stop"),
    "recording must have stopped"
  );
});

test("every turn is tagged exactly once, whatever the cadence decides", () => {
  /* Six turns inside one minute: the cadence declines a snapshot for all but
   * the first, and every one of them must still produce its chapter marker.
   * This is the regression the tag/snapshot split was made to survive. */
  const h = harness();
  h.rec.start("m1");
  for (let n = 1; n <= 6; n++) h.turn(n);

  assert.deepEqual(h.turnNumbers(), [1, 2, 3, 4, 5, 6]);
  assert.ok(
    h.snapshotsAt.length < 6,
    `the cadence should decline most of these turns, spent ${h.snapshotsAt.length}`
  );
});

test("a turn marked twice before settling is tagged once", () => {
  // Coalesced by scheduleSettle, which cancels the pending settle on each mark,
  // so only one `fire` ever runs. The repeats-across-settles case below is the
  // one that actually exercises the guard.
  const h = harness();
  h.rec.start("m1");
  h.rec.mark(3);
  h.rec.mark(3);
  h.rec.mark(3);
  h.advance(SETTLE_MS + 1);

  assert.deepEqual(h.turnNumbers(), [3]);
});

test("a turn that settles repeatedly is still tagged once", () => {
  /* The real shape of this: content.js re-marks the live match every three
   * seconds, so the same turn number settles over and over between one turn and
   * the next. Each of those reaches `fire`, and only the turn-moved guard stops
   * every one of them minting another chapter chip for a turn already tagged. */
  const h = harness();
  h.rec.start("m1");
  h.turn(4);
  h.turn(4);
  h.turn(4);

  assert.deepEqual(h.turnNumbers(), [4]);

  // And the next real turn still gets through.
  h.turn(5);
  assert.deepEqual(h.turnNumbers(), [4, 5]);
});

test("the closing frame does not re-tag a turn that already settled", () => {
  /* Tagging used to live inside keyframe(), which made finalFrame's tag
   * unconditional - so the last turn of every match got a second marker and a
   * duplicate chapter chip. */
  const h = harness();
  h.rec.start("m1");
  h.turn(1);
  h.turn(2);
  h.rec.stop("end");
  h.advance(SETTLE_MS + 1);

  assert.deepEqual(h.turnNumbers(), [1, 2], "no duplicate for the final turn");
});

test("a turn that ends the match before settling is still tagged", () => {
  /* The mirror of the previous case: stop("end") cancels the pending settle, so
   * this turn never reaches `fire` and finalFrame is its only chance at a
   * marker. Losing it drops the last chapter chip of the match. */
  const h = harness();
  h.rec.start("m1");
  h.turn(1);
  h.rec.mark(2); // no settle - the match ends first
  h.rec.stop("end");
  h.advance(SETTLE_MS + 1);

  assert.deepEqual(h.turnNumbers(), [1, 2]);
});

test("the closing frame is spent even when the cadence would decline it", () => {
  // It is the board the match ended on and no later snapshot supersedes it.
  const h = harness();
  h.rec.start("m1");
  h.turn(1);
  const beforeStop = h.snapshotsAt.length;
  h.rec.stop("end");
  h.advance(SETTLE_MS + 1);

  assert.equal(h.snapshotsAt.length, beforeStop + 1, "one closing snapshot");
});

test("snapshots are spent on the cadence, not on turn count", () => {
  /* The whole point of the change: 20 turns in ten minutes should cost about
   * ten snapshots, not twenty. Asserted as a range because the cadence lands on
   * the first settled turn past each minute, and turns do not divide evenly
   * into minutes. */
  const h = harness();
  h.rec.start("m1");
  for (let n = 1; n <= 20; n++) {
    h.rec.mark(n);
    h.advance(30_000); // a turn every 30s -> ten minutes total
  }

  assert.deepEqual(h.turnNumbers().length, 20, "every turn still tagged");
  assert.ok(
    h.snapshotsAt.length >= 8 && h.snapshotsAt.length <= 12,
    `expected ~10 snapshots across ten minutes, got ${h.snapshotsAt.length}`
  );
});

test("the cadence gap is honoured between consecutive snapshots", () => {
  // Measured directly rather than inferred from a count, so a cadence that
  // drifted or reset would show up here.
  const h = harness();
  h.rec.start("m1");
  for (let n = 1; n <= 30; n++) {
    h.rec.mark(n);
    h.advance(20_000);
  }

  for (let i = 1; i < h.snapshotsAt.length; i++) {
    const gap = h.snapshotsAt[i] - h.snapshotsAt[i - 1];
    assert.ok(gap >= 60_000, `snapshots ${i - 1}->${i} only ${gap}ms apart`);
  }
});

test("pointer capture is asked of rrweb, and movement is sampled rather than raw", () => {
  /* The whole point of recording a card game's pointer is the card a player
   * picked up, hovered and put back down, none of which the DOM shows. Two ways
   * to lose it silently: `mousemove: false` records nothing, and `true` is not a
   * rate - rrweb reads only a number as a throttle, so a non-number here is the
   * unthrottled stream at whatever rate the mouse reports. */
  const h = harness();
  h.rec.start("m1");

  const sampling = h.config().sampling;
  assert.equal(typeof sampling.mousemove, "number", "movement must be sampled at a stated interval");
  assert.ok(sampling.mousemove > 0, "a non-positive interval is not a rate");
  assert.equal(sampling.mouseInteraction, true, "clicks are the cheap half and are never sampled");
});

test("pointer events do not move the snapshot cadence", () => {
  /* Snapshots are spent on settled boards, and a board settles from `mark()` -
   * never from the emit stream. Pointer capture puts ~10 events a second into
   * that stream, so if the cadence ever took its schedule from emits instead,
   * this is where a match would start flashing its way through keyframes. */
  const h = harness();
  h.rec.start("m1");
  const before = h.snapshotsAt.length;
  /* 300ms between events, and 90s of them. Both numbers are load-bearing: under
   * SETTLE_MS each event would cancel the settle the one before it scheduled, so
   * a cadence that HAD taken its schedule from the emit stream would still never
   * fire; and under KEYFRAME_EVERY_MS the policy would decline every snapshot
   * whatever asked for one. Either way the test would pass on the bug. */
  for (let i = 0; i < 300; i += 1) {
    h.emit(mouseMove(i * 300));
    h.advance(300);
  }

  assert.deepEqual(h.warnings, [], "the recorder must not have errored");
  assert.equal(h.snapshotsAt.length, before, "no snapshot may be spent without a settled board");
  assert.deepEqual(h.turnNumbers(), [], "pointer traffic is not a turn");
});
