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
    "dashboard/replay-html.js constructs new rrwebReplay.Replayer(...)"
  );
});

test("every rrweb member the browser code calls is present on a bundle", () => {
  const record = loadBundle("vendor/rrweb-record.min.js").rrwebRecord;
  const replay = loadBundle("vendor/rrweb-replay.min.js").rrwebReplay;
  const sources = {
    "capture/dom-recorder.js": record,
    "dashboard/replay-html.js": replay
  };
  for (const [file, exported] of Object.entries(sources)) {
    const global = exported === record ? "rrwebRecord" : "rrwebReplay";
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const used = new Set(
      [...source.matchAll(new RegExp(`${global}\\.([A-Za-z_$][\\w$]*)`, "g"))].map((m) => m[1])
    );
    for (const member of used) {
      assert.ok(
        typeof exported[member] !== "undefined",
        `${file} uses ${global}.${member}, which the vendored bundle does not export`
      );
    }
  }
});
