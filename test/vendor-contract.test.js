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
  // capture/dom-recorder.js snapshots with takeFullSnapshot and tags turns with
  // addCustomEvent so the viewer can label turn chapters. The two are
  // independent: every turn is tagged, while snapshots run on a time cadence, so
  // a missing addCustomEvent costs the chapter chips and nothing else.
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

test("every element the content scripts inject into the page is blocked from capture", () => {
  /* Every content script, not one file: the toast and the banner have moved
   * once already (content.js -> capture/page-ui.js), and this check silently
   * guards nothing the moment it is looking at the wrong file. */
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const source = manifest.content_scripts[0].js
    .filter((rel) => !rel.startsWith("vendor/"))
    .map((rel) => fs.readFileSync(path.join(root, rel), "utf8"))
    .join("\n");
  const recorder = fs.readFileSync(path.join(root, "capture/dom-recorder.js"), "utf8");
  const blockClass = recorder.match(/BLOCK_CLASS\s*=\s*"([^"]+)"/)?.[1];
  assert.ok(blockClass, "dom-recorder.js must define BLOCK_CLASS");

  // Each element we give an id to is injected into the game page, so it must
  // carry the block class or our own UI ends up inside the replay.
  const injected = [...source.matchAll(/\.id\s*=\s*"(ra-tracker-[\w-]+)"([\s\S]{0,200})/g)];
  assert.ok(injected.length >= 2, "expected the content scripts to inject at least the toast and the banner");
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

/* --- the pointer contract ------------------------------------------------
 *
 * Four things the pointer feature assumes about rrweb that the member sweep
 * above cannot see: two numeric enums that never reach the export surface (the
 * replay bundle exports `Replayer` and nothing else), an instance property, a
 * CSS class name, and how the recorder reads a sampling option. Each one fails
 * silently on an rrweb bump - a renamed class leaves both surfaces quietly back
 * on rrweb's black arrow, a shifted enum value leaves the cursor hidden on every
 * new replay - so each is pinned against the bundle text.
 *
 * Source scraping rather than evaluation, because these live in closures a bare
 * VM cannot reach: the enums are minified into the bundle body, and constructing
 * a Replayer would need a real DOM. */
const replayBundle = fs.readFileSync(path.join(root, "vendor/rrweb-replay.min.js"), "utf8");
const recordBundle = fs.readFileSync(path.join(root, "vendor/rrweb-record.min.js"), "utf8");
const replayCss = fs.readFileSync(path.join(root, "vendor/rrweb.min.css"), "utf8");
// rrweb's own mousemove throttle when the option is not a number. Asserted
// against the bundle below, and MOUSEMOVE_MS is stated as twice it.
const RRWEB_DEFAULT_MOUSEMOVE_MS = 50;

test("the IncrementalSource values replay-timeline.js hard-codes are rrweb's own", () => {
  // MOVE_SOURCES in replay/replay-timeline.js. Drag is the one that matters
  // most and is the easiest to think is a MouseMove: it is a source of its own.
  for (const [name, value] of [["MouseMove", 1], ["MouseInteraction", 2], ["TouchMove", 6], ["Drag", 12]]) {
    assert.ok(
      new RegExp(`([\\w$]+)\\[\\1\\.${name}=${value}\\]`).test(replayBundle),
      `rrweb no longer numbers IncrementalSource.${name} as ${value}; replay-timeline.js reads it as that`
    );
  }
  /* The values alone are half the contract. This is the other half: these three
   * sources, and no others, are the ones the replayer positions its cursor
   * from - so rrweb moving Drag out of that branch would leave replay-timeline.js
   * counting a source that no longer puts a cursor anywhere. The identifier is
   * back-referenced rather than named: it is the minifier's, not rrweb's. */
  assert.ok(
    /case ([\w$]+)\.Drag:case \1\.TouchMove:case \1\.MouseMove:/.test(replayBundle),
    "the replayer no longer positions its cursor from exactly Drag/TouchMove/MouseMove, so " +
      "MOVE_SOURCES in replay-timeline.js is now the wrong set"
  );
});

test("the MouseInteraction types that move the cursor are the ones we count", () => {
  // POINTING_INTERACTIONS in replay/replay-timeline.js, and the replayer branch
  // it mirrors. Both halves are pinned: the values, and the fact that these
  // three types - and no others - are what position the cursor.
  for (const [name, value] of [["Click", 2], ["TouchStart", 7], ["TouchEnd", 9]]) {
    assert.ok(
      new RegExp(`([\\w$]+)\\[\\1\\.${name}=${value}\\]`).test(replayBundle),
      `rrweb no longer numbers MouseInteraction.${name} as ${value}`
    );
  }
  assert.ok(
    /case ([\w$]+)\.Click:case \1\.TouchStart:case \1\.TouchEnd:/.test(replayBundle),
    "the replayer no longer positions its cursor for exactly Click/TouchStart/TouchEnd, so " +
      "replay-timeline.js is now counting the wrong interactions as pointer data"
  );
});

test("the Replayer still hangs its cursor element off `.mouse`, classed replayer-mouse", () => {
  /* replay/replay-core.js hides `replayer.mouse`; both stylesheets restyle
   * `.replayer-mouse`. Renaming either is a silent revert - the cursor comes
   * back parked on old replays, in rrweb's near-invisible black. */
  assert.ok(
    /this\.mouse=document\.createElement\(/.test(replayBundle),
    "replay/replay-core.js reads `replayer.mouse` off the Replayer instance"
  );
  assert.ok(
    /this\.mouse\.classList\.add\("replayer-mouse"\)/.test(replayBundle),
    "dashboard.css and viewer.css both restyle .replayer-mouse"
  );
  assert.ok(
    /\.replayer-mouse\.touch-device\{/.test(replayCss),
    "the touch-device ring is what the `:not(.touch-device)` in both stylesheets exempts"
  );
});

test("the recorder reads sampling.mousemove as a number, not a flag", () => {
  /* capture/dom-recorder.js passes MOUSEMOVE_MS. rrweb takes only a number as
   * the throttle and falls back to its own default otherwise, so a bump that
   * changed this reading would turn a stated interval into the unthrottled
   * stream at whatever rate the mouse reports - the byte cost this feature was
   * kept off for in the first place. The default is pinned too: the constant's
   * comment claims to be half of it. */
  assert.ok(
    new RegExp(`typeof ([\\w$]+)\\.mousemove=="number"\\?\\1\\.mousemove:${RRWEB_DEFAULT_MOUSEMOVE_MS}`).test(recordBundle),
    `rrweb no longer reads sampling.mousemove as a number defaulting to ${RRWEB_DEFAULT_MOUSEMOVE_MS}ms`
  );
  const recorder = stripComments(fs.readFileSync(path.join(root, "capture/dom-recorder.js"), "utf8"));
  const declared = recorder.match(/const MOUSEMOVE_MS = (\d+);/);
  assert.ok(declared, "capture/dom-recorder.js must state its sampling interval as a number");
  /* Pinned to the value, not to a range. Two pieces of prose are written
   * against it - the constant's own "halving what the rrweb default spends" and
   * the README's "sampled ten times a second" - and a bound of ">= 50" licenses
   * exactly the value that makes both false while the suite stays green. */
  assert.equal(
    Number(declared[1]),
    2 * RRWEB_DEFAULT_MOUSEMOVE_MS,
    "MOUSEMOVE_MS is documented in capture/dom-recorder.js and in the README as half rrweb's " +
      "own sampling rate; changing it means changing both"
  );
});
