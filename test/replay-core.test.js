/* The one decision replay-core.js makes on its own: whether to show a cursor.
 *
 * The file's own header says there is nothing here to unit test, and for the
 * transport that is still true - play, pause, seek and scale are rrweb and the
 * DOM all the way down, and the arithmetic behind them is pure and covered in
 * replay-timeline.js. `hasPointerData` is covered there too.
 *
 * What was covered nowhere is the line joining the two. Deleting it, inverting
 * it, or dropping `hasPointerData` from the destructure at the top of create()
 * are each invisible to every other test in this suite, and each one is a
 * user-visible break: a cursor missing from every new replay, or rrweb's fake
 * one back on every old one, parked in the corner for the whole match.
 *
 * So the harness stubs rrweb and the DOM down to the few members create()
 * actually touches, and asserts on that line alone. It is deliberately not a
 * transport test: nothing here drives playback.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const readSrc = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const el = () => ({
  style: {},
  clientWidth: 1280,
  clientHeight: 800,
  setAttribute() {},
});

/** A mounted replay, plus rrweb's cursor element to inspect. */
function mount(events) {
  const mouse = el();
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    JSON, Math, Number, Array, Set, Object, String,
    setTimeout, clearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
    // Autoplay is not what this file tests, and asking for less motion is the
    // answer that keeps the transport still: see reducedMotion() in the core.
    matchMedia: () => ({ matches: true }),
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(readSrc("replay/replay-timeline.js"), context, { filename: "replay-timeline.js" });

  sandbox.rrwebReplay = {
    Replayer: function Replayer() {
      this.mouse = mouse;
      this.wrapper = el();
      this.iframe = el();
      this.getMetaData = () => ({ totalTime: 60000 });
      this.getCurrentTime = () => 0;
      this.on = () => {};
      this.play = () => {};
      this.pause = () => {};
      this.setConfig = () => {};
      this.destroy = () => {};
    },
  };
  vm.runInContext(readSrc("replay/replay-core.js"), context, { filename: "replay-core.js" });

  const controller = sandbox.RAReplayCore.create({
    stage: el(),
    scaleEl: el(),
    events,
    meta: { viewport: { w: 1280, h: 800 } },
  });
  assert.ok(controller, "the harness must produce a mounted replay");
  return { controller, mouse };
}

// A stream rrweb will accept, with a full snapshot to open it.
const snapshot = { type: 2, timestamp: 0, data: { node: {} } };
const mouseMove = { type: 3, timestamp: 500, data: { source: 1, positions: [{ x: 1, y: 2, id: 9 }] } };
const mutation = { type: 3, timestamp: 400, data: { source: 0 } };

test("a recording with pointer data keeps rrweb's cursor", () => {
  const { mouse } = mount([snapshot, mutation, mouseMove]);
  assert.notEqual(mouse.style.display, "none", "the cursor is the feature; it must be left alone");
});

test("a recording without pointer data has the cursor taken away", () => {
  /* Every replay made before pointer capture was turned on. rrweb mounts its
   * cursor whatever the stream holds, and parks it in the top-left corner for
   * the match's whole length - a player who never moved, rather than a
   * recording that never watched. */
  const { mouse } = mount([snapshot, mutation]);
  assert.equal(mouse.style.display, "none");
});

test("a replayer that exposes no cursor element is not reached into", () => {
  // Guards the `replayer.mouse &&` half: an rrweb bump that renames it must
  // cost the hiding, not the mount.
  const events = [snapshot, mutation];
  const mouse = el();
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    JSON, Math, Number, Array, Set, Object, String,
    setTimeout, clearTimeout,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: true }),
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(readSrc("replay/replay-timeline.js"), context, { filename: "replay-timeline.js" });
  sandbox.rrwebReplay = {
    Replayer: function Replayer() {
      this.wrapper = el();
      this.iframe = el();
      this.getMetaData = () => ({ totalTime: 60000 });
      this.getCurrentTime = () => 0;
      this.on = () => {};
      this.play = () => {};
      this.pause = () => {};
      this.setConfig = () => {};
      this.destroy = () => {};
    },
  };
  vm.runInContext(readSrc("replay/replay-core.js"), context, { filename: "replay-core.js" });

  const controller = sandbox.RAReplayCore.create({
    stage: el(), scaleEl: el(), events, meta: { viewport: { w: 1280, h: 800 } },
  });
  assert.ok(controller, "a Replayer with no cursor element must still mount");
  assert.notEqual(mouse.style.display, "none");
});
