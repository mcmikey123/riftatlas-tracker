"use strict";

/* content.js, actually run.
 *
 * Everything else about the content script is checked by source shape or by
 * driving a module directly, and neither would notice the one mistake this
 * decomposition makes easiest: a call into a global that no longer exists under
 * that name. In a browser that throw is swallowed by the try/catch around the
 * tick and the extension goes on running with no capture at all, one console
 * warning per frame.
 *
 * So this loads every content script the manifest lists, in the order it lists
 * them, into a sandbox holding the page APIs boot() reaches for, and then runs
 * the three things that drive it: a mutation frame, the three-second sweep and
 * a pagehide. Nothing may warn.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { el } = require("./fake-dom.js");

const root = path.join(__dirname, "..");
const readSrc = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const manifest = JSON.parse(readSrc("manifest.json"));

function boot(page) {
  const warnings = [];
  const info = [];
  const intervals = [];
  const listeners = {};
  let frame = null;
  let observerCallback = null;

  const document = page || el({});
  document.body = el({});
  document.createElement = (tag) => {
    const node = el({ tag });
    node.style = {};
    node.addEventListener = () => {};
    node.remove = () => {};
    node.appendChild = () => {};
    return node;
  };
  document.body.appendChild = () => {};

  const sandbox = {
    console: {
      warn: (...a) => warnings.push(a.join(" ")),
      error: (...a) => warnings.push(a.join(" ")),
      info: (...a) => info.push(a.join(" ")),
      log() {},
    },
    document,
    location: { href: "https://play.riftatlas.com/", search: "" },
    performance: { now: () => 0 },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    TextEncoder,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: (fn) => intervals.push(fn),
    requestAnimationFrame: (fn) => (frame = fn),
    addEventListener: (type, fn) => (listeners[type] = fn),
    removeEventListener() {},
    MutationObserver: class {
      constructor(cb) {
        observerCallback = cb;
      }
      observe() {}
      takeRecords() {
        return [];
      }
    },
    chrome: {
      runtime: { id: "test" },
      storage: {
        local: { get: (defaults, cb) => cb(Array.isArray(defaults) ? {} : defaults), set() {} },
        onChanged: { addListener: (fn) => (listeners.storage = fn) },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  for (const rel of manifest.content_scripts[0].js) {
    if (rel.startsWith("vendor/")) continue; // rrweb is not part of this wiring
    vm.runInContext(readSrc(rel), context, { filename: rel });
  }

  return {
    warnings,
    info,
    sandbox,
    /** One observer frame carrying `nodes` as added nodes. */
    mutate(nodes) {
      observerCallback([{ addedNodes: nodes }]);
      frame();
    },
    sweep: () => intervals.forEach((fn) => fn()),
    pagehide: () => listeners.pagehide(),
    storageChanged: (changes) => listeners.storage(changes, "local"),
  };
}

test("the content script boots against a page with nothing on it", () => {
  const h = boot();
  assert.ok(h.info.includes("[RA-Tracker] active"), "boot() must run to the end");
  assert.deepEqual(h.warnings, []);
});

test("every global content.js reaches for is published by the time it runs", () => {
  /* The manifest-order check next door is a source scan; this is the same
   * invariant executed. A name that moved between modules fails here at the
   * first tick rather than silently in a browser. */
  const h = boot();
  h.mutate([{ nodeType: 1, textContent: "VICTORY" }]);
  h.sweep();
  h.pagehide();
  h.storageChanged({ matches: { newValue: [], oldValue: [] } });

  assert.deepEqual(h.warnings, [], "a swallowed throw here is a capture that never runs");
});

/** The board the tests below play a whole match on, scores and all. */
function boardInPlay(scoreText) {
  // Both scores are attributes on the board root, so the game-state element is
  // the whole score track as far as anything here is concerned.
  const gameState = el({
    sel: ['[data-testid="game-state"]'],
    dataset: {
      roomPhase: "in_game",
      roomMode: "ranked",
      turnNumber: "3",
      viewerScore: scoreText,
      opponentScore: "0",
    },
  });
  const page = el({
    kids: [
      gameState,
      el({ sel: ['[data-testid="room-code"]'], dataset: { roomCode: "ABC123" } }),
    ],
  });
  return { page, gameState };
}

test("a board in play starts a match, and the sweep keeps it", () => {
  // The whole stack, wired as the manifest wires it: the tick reads the board
  // through RATBoard, starts a record through RATLifecycle, and the sweep saves
  // it. Any missing wire shows up as no match at all.
  const h = boot(boardInPlay("0").page);
  h.sweep();

  const live = h.sandbox.RATLifecycle.current();
  assert.ok(live, "a board in play must produce a record");
  assert.equal(live.roomCode, "ABC123");
  assert.equal(live.turns, 3);
  assert.deepEqual(h.warnings, []);
});

test("ending a match, resuming it and ending it again drives the toast both ways", () => {
  /* Everything above stops at a match that is still being played, and the two
   * things drawn on the page when one FINISHES - the confirmation toast, and
   * the removal of it when an end turns out to have been false - are reached
   * only from here, through RATPageUI. test/match-lifecycle.test.js stubs that
   * module wholesale, so neither name was executed by anything: renaming either
   * left the suite green and every finished match throwing inside the tick,
   * where content.js catches it and prints one warning per frame.
   *
   * So the board carries both scores and the match is played to its end:
   *
   *   a "VICTORY" banner ends it, and raises the toast;
   *   the next sweep sees the same room at the same turn with nothing decisive
   *   behind that end, reads it as false, and takes the toast down again;
   *   the score on the board then reaches 8, which ends it for real.
   */
  const { page, gameState } = boardInPlay("0");
  const h = boot(page);

  h.sweep();
  assert.ok(h.sandbox.RATLifecycle.current(), "the match must be live before it can end");

  h.mutate([{ nodeType: 1, textContent: "VICTORY" }]);
  assert.equal(h.sandbox.RATLifecycle.current(), null, "a victory banner ends the match");

  h.sweep();
  assert.ok(
    h.sandbox.RATLifecycle.current(),
    "the same board at the same turn is a false end, and the record is reopened"
  );

  gameState.dataset.viewerScore = "8";
  h.sweep();
  assert.equal(h.sandbox.RATLifecycle.current(), null, "first to 8 ends it for good");

  assert.deepEqual(h.warnings, [], "a swallowed throw here is a warning per frame, forever");
});
