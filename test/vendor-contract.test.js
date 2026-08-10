/* Locks the shape of the vendored rrweb bundles.
 *
 * These bundles are the one dependency the browser code cannot be unit tested
 * against, so a mismatch between what they export and what our code calls
 * shows up only at runtime, mid-match, as a caught error and a lost recording.
 * That is exactly what happened: `dom-recorder.js` called `rrwebRecord.record`,
 * which exists on the all-in-one `rrweb` bundle but not on the record-only one,
 * where the record function IS the global.
 *
 * Evaluating each bundle in a bare VM and asserting the surface our code uses
 * catches that class of break at test time, including after any rrweb bump.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

/** Drops comments so a rule can assert on code rather than on prose about it. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Evaluate a vendored bundle with just enough globals to reach its export. */
function loadBundle(file) {
  const context = {
    window: {},
    document: {},
    navigator: { userAgent: "" },
    console: { log() {}, warn() {}, error() {} }
  };
  context.self = context;
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  return context;
}

test("the record bundle exports the record function as the global itself", () => {
  const { rrwebRecord } = loadBundle("vendor/rrweb-record.min.js");
  assert.strictEqual(
    typeof rrwebRecord,
    "function",
    "capture/dom-recorder.js calls rrwebRecord({ emit }) directly"
  );
  assert.strictEqual(
    typeof rrwebRecord.record,
    "undefined",
    "a `.record` member would mean the wrong bundle was vendored"
  );
});

test("the record function carries the helpers the recorder drives", () => {
  const { rrwebRecord } = loadBundle("vendor/rrweb-record.min.js");
  // capture/dom-recorder.js keyframes with takeFullSnapshot and tags each one
  // with addCustomEvent so the viewer can label turn chapters.
  assert.strictEqual(typeof rrwebRecord.takeFullSnapshot, "function");
  assert.strictEqual(typeof rrwebRecord.addCustomEvent, "function");
});

test("the replay bundle exports a Replayer constructor", () => {
  const { rrwebReplay } = loadBundle("vendor/rrweb-replay.min.js");
  assert.strictEqual(typeof rrwebReplay, "object");
  assert.strictEqual(
    typeof rrwebReplay.Replayer,
    "function",
    "replay/replay-core.js constructs new rrwebReplay.Replayer(...)"
  );
});

test("the recorder avoids rrweb's crashing blockSelector path", () => {
  // rrweb 2.0.0-alpha.4's isBlocked() resolves a text node to its parentElement
  // and then calls .matches(blockSelector) on the ORIGINAL node, so any text node
  // reaching that branch throws "e.matches is not a function" — asynchronously,
  // inside rrweb's own mutation callback, where our guard cannot catch it. The
  // branch is only entered when blockSelector is set. Use blockClass instead.
  const source = stripComments(fs.readFileSync(path.join(root, "capture/dom-recorder.js"), "utf8"));
  assert.ok(
    !/\bblockSelector\b/.test(source),
    "blockSelector triggers an upstream rrweb crash; block our UI with blockClass"
  );
  assert.ok(/\bblockClass\b/.test(source), "our injected UI must still be excluded from capture");
});

test("every element content.js injects into the page is blocked from capture", () => {
  const source = fs.readFileSync(path.join(root, "content.js"), "utf8");
  const recorder = fs.readFileSync(path.join(root, "capture/dom-recorder.js"), "utf8");
  const blockClass = recorder.match(/BLOCK_CLASS\s*=\s*"([^"]+)"/)?.[1];
  assert.ok(blockClass, "dom-recorder.js must define BLOCK_CLASS");

  // Each element content.js gives an id to is injected into the game page, so it
  // must carry the block class or our own UI ends up inside the replay.
  const injected = [...source.matchAll(/\.id\s*=\s*"(ra-tracker-[\w-]+)"([\s\S]{0,200})/g)];
  assert.ok(injected.length >= 2, "expected content.js to inject at least the toast and the banner");
  for (const [, id, following] of injected) {
    assert.ok(
      following.includes(blockClass),
      `#${id} is injected into the page but never gets the "${blockClass}" class`
    );
  }
});

test("every rrweb member the browser code calls is present on a bundle", () => {
  const record = loadBundle("vendor/rrweb-record.min.js").rrwebRecord;
  const replay = loadBundle("vendor/rrweb-replay.min.js").rrwebReplay;
  const sources = {
    "capture/dom-recorder.js": record,
    "replay/replay-core.js": replay
  };
  for (const [file, exported] of Object.entries(sources)) {
    const global = exported === record ? "rrwebRecord" : "rrwebReplay";
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const used = new Set(
      [...source.matchAll(new RegExp(`${global}\\.([A-Za-z_$][\\w$]*)`, "g"))].map((m) => m[1])
    );
    // A file that touches no member at all makes the loop below pass vacuously,
    // which is how this test would silently stop guarding anything if the rrweb
    // calls were ever moved to another file again.
    assert.ok(used.size > 0, `${file} calls no ${global} member — has the code moved?`);
    for (const member of used) {
      assert.ok(
        typeof exported[member] !== "undefined",
        `${file} uses ${global}.${member}, which the vendored bundle does not export`
      );
    }
  }
});
