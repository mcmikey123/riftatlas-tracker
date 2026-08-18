"use strict";

/* The dashboard, actually run.
 *
 * legacy.js was drained into seven modules, each publishing a window.RATracker*
 * global and each reading the others off that global - some at evaluation time,
 * some inside a chrome callback, some only once a button is pressed. Nothing
 * about that arrangement is checked by a compiler and, until this file, nothing
 * was checked by a test either: test/dashboard-wiring.test.js reads the load
 * order and the accessor idiom out of the source, and source shape cannot tell
 * whether a name a caller reaches for still exists.
 *
 * Renaming an export was therefore free. Nine of them could be renamed with the
 * suite still green and the page dead in a browser - `ensureVisualIds` throwing
 * on every paint, `forgetAllVisual` throwing AFTER the matches were dropped from
 * memory but before storage was cleared, `say` undefined in four files at once.
 *
 * So this loads every classic script dashboard.html lists, in the order it
 * lists them, into a sandbox holding the page APIs the dashboard reaches for,
 * and then drives the real entry points: the paint, the bridge main.js reads,
 * the delegated click / change / input listeners, and a storage change. Nothing
 * may throw and nothing may warn.
 *
 * The page is dashboard.html itself, parsed (test/fake-page.js), rather than a
 * hand-written list of ids: every lookup in these files is null-guarded on
 * purpose, so a fixture that did not have the real elements would let the whole
 * of it "pass" having rendered nothing. The assertions below therefore also
 * check that something was actually painted.
 *
 * Chrome's callbacks run synchronously here. In a browser a throw inside one is
 * an uncaught error nobody sees; here it reaches the test.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { loadPage, element } = require("./fake-page.js");

const root = path.join(__dirname, "..");
const readSrc = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const html = readSrc("dashboard/dashboard.html");

/* The classic scripts, in document order. Modules are skipped - they are
 * deferred, so they cannot participate in the eval-time wiring this checks -
 * and so is rrweb, which is a vendored player and not part of it. */
const CLASSIC = [...html.matchAll(/<script (type="module" )?src="([^"]+)"/g)]
  .filter((m) => !m[1] && !m[2].includes("vendor/"))
  .map((m) => path.posix.normalize(path.posix.join("dashboard", m[2])));

/* A throw inside a .then() is a rejected promise nobody holds, which is exactly
 * what a browser would report and swallow. Registering a handler also stops the
 * default crash, so the assertion below is the only thing that reads them. */
const rejections = [];
process.on("unhandledRejection", (err) => rejections.push(err));

// ---- fixtures ------------------------------------------------------------

const match = (over) =>
  Object.assign(
    {
      id: "m1",
      startedAt: "2026-02-01T10:00:00.000Z",
      endedAt: "2026-02-01T10:20:00.000Z",
      durationMs: 1200000,
      mode: "ranked",
      result: "win",
      myChampion: "Alba, the Dawnbreaker",
      opponentChampion: "Corin, Tidecaller",
      deckName: "Hollowmark Aggro",
      myScore: 8,
      opponentScore: 3,
    },
    over
  );

const replayRecord = (over) =>
  Object.assign(
    {
      matchId: "m1",
      startedAt: 1770000000000,
      compressedBytes: 3_500_000,
      chunkCount: 12,
      state: "complete",
      stats: { keyframes: 4, meanDeltaBytes: 900, captureP50Ms: 8, captureMaxMs: 40 },
    },
    over
  );

/* An empty ra-visual database, which is what "no recording for this match" is:
 * the dashboard reads replays in the page rather than over sendMessage, so the
 * click that opens one goes through store/idb.js and store/replay-store.js for
 * real. Requests settle on a microtask, so one turn of the loop drains a read.
 */
function emptyReplayDb() {
  const request = (result) => {
    const req = { result, error: null };
    queueMicrotask(() => req.onsuccess && req.onsuccess());
    return req;
  };
  const store = {
    get: () => request(undefined),
    getAll: () => request([]),
    put: () => request(undefined),
    delete: () => request(undefined),
    clear: () => request(undefined),
  };
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => ({ objectStore: () => store }),
    close() {},
  };
  return { open: () => request(db) };
}

const HISTORY = [
  match({ id: "m1" }),
  match({ id: "m2", deckName: "", result: "loss", startedAt: "2026-01-30T09:00:00.000Z" }),
  match({ id: "m3", deckName: "", myChampion: " ", startedAt: "2026-01-29T09:00:00.000Z" }),
];

// ---- the sandbox ---------------------------------------------------------

function boot(options = {}) {
  rejections.length = 0;

  const page = loadPage(html);
  const document = page.document;

  const warnings = [];
  const toasts = [];
  const asked = [];
  const timers = [];
  const downloads = [];
  const sent = [];
  const writes = [];
  const removed = [];
  const storageListeners = [];

  const storage = Object.assign(
    { matches: options.matches || [], settings: options.settings || {} },
    options.storage || {}
  );

  const listReply = () => ({
    ok: true,
    replays: options.replays || [],
    assets: options.assets || { count: 0, bytes: 0 },
  });

  const chrome = {
    runtime: {
      id: "ra-test",
      lastError: null,
      sendMessage(message, cb) {
        sent.push(message);
        if (cb) cb(listReply());
      },
    },
    storage: {
      local: {
        get(query, cb) {
          let out = {};
          if (query === null || query === undefined) out = Object.assign({}, storage);
          else if (typeof query === "string") out = { [query]: storage[query] };
          else if (Array.isArray(query)) query.forEach((k) => (out[k] = storage[k]));
          else for (const [k, fallback] of Object.entries(query)) out[k] = k in storage ? storage[k] : fallback;
          cb(out);
        },
        set(entries, cb) {
          Object.assign(storage, entries);
          writes.push(entries);
          if (cb) cb();
        },
        remove(keys, cb) {
          [].concat(keys).forEach((k) => {
            removed.push(k);
            delete storage[k];
          });
          if (cb) cb();
        },
      },
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
    permissions: {
      contains: (_p, cb) => cb(options.downloadsGranted === true),
      request: (_p, cb) => cb(options.downloadsGrantable === true),
    },
    downloads: {
      download(spec, cb) {
        downloads.push(spec);
        if (cb) cb(1);
      },
    },
  };

  const sandbox = {
    console: {
      warn: (...a) => warnings.push(a.join(" ")),
      error: (...a) => warnings.push(a.join(" ")),
      info() {},
      log() {},
    },
    document,
    chrome,
    location: { href: "chrome-extension://ra/dashboard/dashboard.html", search: "" },
    indexedDB: emptyReplayDb(),
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    performance: { now: () => 0 },
    TextEncoder,
    TextDecoder,
    Promise, // host promises, so an unhandled rejection reaches the handler above
    CSS: { escape: (s) => String(s) },
    URL: { createObjectURL: () => "blob:ra/1", revokeObjectURL() {} },
    Blob: class {
      constructor(parts) {
        this.size = (parts || []).reduce((n, p) => n + Buffer.byteLength(String(p)), 0);
      }
    },
    Option: class {
      constructor(text, value) {
        const node = element("option", { value: value === undefined ? text : value });
        node.textContent = text;
        return node;
      }
    },
    Response: class {},
    DecompressionStream: class {},
    CompressionStream: class {},
    setTimeout: (fn) => timers.push(fn),
    clearTimeout() {},
    setInterval: () => 0,
    requestAnimationFrame: (fn) => timers.push(fn),
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  /* What main.js publishes for the classic half. It is an ES module and cannot
   * be evaluated here, but everything below reaches the toast and the dialog
   * through these two names and nothing else, so this is the whole of that
   * seam. Both answer immediately: the flows behind them are the ones this file
   * exists to reach. */
  sandbox.RATrackerToast = (message, opts) => toasts.push({ message, kind: opts && opts.kind });
  sandbox.RATrackerDialog = {
    isOpen: () => false,
    open: () => Promise.resolve(true),
    // Always confirmed: what these flows do once they are agreed to is what
    // this file exists to reach, and a cancel returns before any of it.
    confirm(opts) {
      asked.push(opts);
      return Promise.resolve(true);
    },
    alert(opts) {
      asked.push(opts);
      return Promise.resolve();
    },
    textPrompt(opts) {
      asked.push(opts);
      return Promise.resolve(options.typed || null);
    },
    defer(run) {
      run();
    },
  };

  const context = vm.createContext(sandbox);
  for (const rel of CLASSIC) vm.runInContext(readSrc(rel), context, { filename: rel });

  const need = (selector) => {
    const el = document.querySelector(selector);
    assert.ok(el, `dashboard.html no longer has ${selector}, so this test drives nothing`);
    return el;
  };

  return {
    sandbox,
    document,
    warnings,
    toasts,
    asked,
    sent,
    writes,
    removed,
    downloads,
    storage,
    click: (selector) => page.dispatch(need(selector), "click"),
    change(selector, props) {
      const el = need(selector);
      Object.assign(el, props || {});
      return page.dispatch(el, "change");
    },
    input(selector, value) {
      const el = need(selector);
      el.value = value;
      return page.dispatch(el, "input");
    },
    storageChanged: (changes) => storageListeners.forEach((fn) => fn(changes, "local")),
    runTimers() {
      while (timers.length) timers.shift()();
    },
    /* Lets every promise the drive above created settle, then reports what a
     * browser would have printed: a console warning, or a rejection nobody
     * held. Both are how a missing global shows up once it is one `.then()`
     * away from the click that reached it. */
    async quiet(why) {
      // Four turns: the deepest chain here is a replay read, which awaits the
      // database, the chunk list and the assets before the handler that could
      // throw even runs, and a rejection is reported one turn after that.
      for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
      assert.deepEqual(rejections.map(String), [], why || "a rejected promise nobody held");
      assert.deepEqual(warnings, [], why || "the dashboard warned");
    },
  };
}

/* The row Matches draws for one match. view-matches.js is an ES module and
 * cannot be evaluated here, but the attributes it carries are legacy.js's own -
 * every one of these was a branch of the listener in legacy.js before the port,
 * and the module draws them precisely so that a click still lands there. This
 * is that markup, and nothing else about the Matches view. */
const matchRowHtml = (id) => `
  <tr data-row="${id}">
    <td><button data-log="${id}"><span>&#9656;</span> Log</button></td>
    <td><button data-del="${id}">Delete</button></td>
    <td><button data-deckapply="${id}">Apply to unlabelled</button></td>
    <td><select data-deck="${id}"><option value="">none</option></select></td>
    <td><select class="result-edit" data-id="${id}"><option value="win">win</option></select></td>
    <td><textarea data-notes="${id}"></textarea><span data-savestate="${id}"></span></td>
  </tr>
  <tr><td><div data-logbox="${id}" hidden></div></td></tr>`;

// ---- booting -------------------------------------------------------------

test("the dashboard boots against a browser with nothing stored", async () => {
  const h = boot();
  await h.quiet("an empty history must still paint");

  assert.equal(h.document.querySelector("#tGames").textContent, "0");
  assert.equal(h.document.querySelector("#tWinrate").textContent, "–");
  assert.ok(h.sandbox.RATrackerLegacy, "legacy.js must publish its bridge");
});

test("every global the dashboard reaches for during a paint is published", async () => {
  /* The load-order check next door is a source scan; this is the same invariant
   * executed. A name that moved between modules fails here on the first paint
   * rather than silently in a browser, where the throw lands inside a
   * chrome.storage callback and takes the rest of load() with it. */
  const h = boot({
    matches: HISTORY,
    replays: [replayRecord({ matchId: "m1" }), replayRecord({ matchId: "m2", startedAt: 1769000000000 })],
    assets: { count: 3, bytes: 120000 },
    storage: { shares: [] },
  });
  await h.quiet("the first paint");

  assert.equal(h.document.querySelector("#tGames").textContent, "3");
  assert.ok(
    h.document.querySelector("#vsTable tbody").innerHTML.includes("Corin"),
    "the Overview must have drawn its aggregate tables"
  );
  assert.equal(h.document.querySelector("#visualPanel").hidden, false);
  assert.equal(
    h.document.querySelectorAll("#visualTable tbody tr").length,
    2,
    "the Replays panel must draw a row per recording"
  );
  assert.ok(h.document.querySelector("#visualTable tfoot").textContent.includes("Total"));
  // The filter row is filled from the match array, which is legacy.js's own.
  assert.ok(h.document.querySelector("#fMyChampion").length > 1, "the champion filter must be filled");
});

test("the bridge main.js reads is whole", async () => {
  /* main.js is deferred and cannot run here, but everything it asks legacy.js
   * for is bound at legacy.js's evaluation - `visualRecords: REPLAYS.records`
   * and friends are references, not calls. A renamed export therefore binds
   * undefined and nothing notices until the shell paints the nav, where it is a
   * TypeError inside shell.js. This is that read, exactly as counts() makes it. */
  const h = boot({ matches: HISTORY, replays: [replayRecord({})] });
  const bridge = h.sandbox.RATrackerLegacy;

  const records = bridge.visualRecords();
  const assets = bridge.visualAssets();
  assert.ok(Array.isArray(records), "visualRecords must answer the list the nav counts");
  assert.equal(records.length, 1);
  assert.ok(assets && typeof assets.bytes === "number");
  assert.equal(typeof bridge.keepMatches(), "number", "the capture card prints this figure");
  assert.equal(bridge.matches().length, 3);
  assert.ok(Array.isArray(bridge.shares()));
  assert.equal(bridge.readOnly(), false);
  assert.equal(bridge.hasVisual("m1"), true);
  assert.equal(bridge.hasVisual("nope"), false);
  assert.equal(typeof bridge.shareBoxInner("m1"), "string");
  assert.deepEqual([...bridge.deckNames()], ["Hollowmark Aggro"]);
  assert.ok(bridge.analyse(HISTORY[0]));
  bridge.render();
  await h.quiet("reading the bridge");
});

// ---- driving it ----------------------------------------------------------

test("every control the dashboard still owns can be operated", async () => {
  const h = boot({
    matches: HISTORY,
    replays: [replayRecord({})],
    storage: { shares: [], log_m1: { id: "m1", log: ["10:00 you played a card"] } },
    settings: { autoBackup: false, lastBackup: Date.now() },
    typed: "Typed Deck",
  });
  h.document.querySelector("[data-matches]").innerHTML = matchRowHtml("m2");

  // The header and the two menus behind it.
  h.click("#exportJson");
  h.click("#exportCsv");
  h.click("#importJson");
  h.click("#viewArchive");
  h.click("#archiveExit");
  h.click("#bulkLabel");
  h.click("#autoDeck");
  h.click("#bannerDismiss");

  // Settings.
  h.change("#visualEnabled", { checked: true });
  h.change("#visualKeep", { value: "40" });
  h.change("#visualCeiling", { value: "9999" });

  // The filter row, which repaints this half as well as the module half.
  h.change("#fMyChampion", { value: "Alba" });
  h.change("#fDates", { value: "30" });
  h.change("#fUnknown", { checked: true });

  // The rows Matches draws, whose branches are still legacy.js's.
  h.click("[data-log='m2']");
  h.click("[data-deckapply='m2']");
  h.change("[data-deck='m2']", { value: "Hollowmark Aggro" });
  h.change(".result-edit", { value: "loss" });
  h.input("[data-notes='m2']", "a note");

  // The Replays view's own two, on markup it drew itself.
  h.click("[data-visual='m1']");
  h.click("[data-visualdel='m1']");

  h.runTimers();
  await h.quiet("driving the page's controls");

  assert.ok(h.asked.length, "the confirms and prompts must have been reached");
  assert.equal(h.document.querySelector("[data-logbox='m2']").hidden, false, "the log toggle must open");
  assert.ok(
    h.writes.some((w) => w.matches),
    "editing a result, a deck and a note must reach the writer"
  );
});

// ---- deleting -------------------------------------------------------------

test("deleting a match takes its log and cards with it", async () => {
  const h = boot({
    matches: HISTORY,
    replays: [replayRecord({ matchId: "m2" })],
    storage: { shares: [], log_m2: { id: "m2", log: ["10:00 you played a card"] }, deckcards_m2: { codes: [] } },
  });
  h.document.querySelector("[data-matches]").innerHTML = matchRowHtml("m2");

  h.click("[data-del='m2']");
  await h.quiet("deleting a match");

  assert.deepEqual(
    h.storage.matches.map((m) => m.id),
    ["m1", "m3"],
    "the match must be gone from the stored array"
  );
  assert.ok(h.removed.includes("log_m2") && h.removed.includes("deckcards_m2"), "and its keys with it");
  assert.ok(
    h.sent.some((m) => m.type === "ra:visual:delete" && m.matchId === "m2"),
    "the service worker must be told to drop the recording"
  );
});

test("a delete that fails part way never leaves a match without its log", async () => {
  /* The confirm says "This cannot be undone", and until the ordering was fixed
   * it could leave a state worse than either outcome it offered.
   *
   * legacy.js used to delete log_<id> and deckcards_<id>, then call
   * REPLAYS.forgetVisual, then write the array. forgetVisual sends to the
   * service worker and repaints the replay panel, so it throws for reasons that
   * have nothing to do with this delete - most plainly an extension context
   * invalidated by a reload, which is what is simulated here. The throw landed
   * between the removal and the write: the keys were gone, the match was not,
   * and the next reload brought the row back with its log and card list
   * permanently empty.
   *
   * Writing the array first makes that state unreachable. Whatever throws
   * afterwards can only orphan bytes nothing references. */
  const h = boot({
    matches: HISTORY,
    replays: [replayRecord({ matchId: "m2" })],
    storage: { shares: [], log_m2: { id: "m2", log: ["10:00 you played a card"] }, deckcards_m2: { codes: [] } },
  });
  h.document.querySelector("[data-matches]").innerHTML = matchRowHtml("m2");

  const boom = new Error("Extension context invalidated.");
  h.sandbox.RATrackerViewReplays.forgetVisual = () => {
    throw boom;
  };

  /* In a browser the throw becomes a rejected promise nobody holds, and the
   * page carries on with whatever state it was left in - which is the point.
   * Here it has to be caught, or the runner attributes it to this test instead
   * of letting the assertions below read the wreckage. legacy.js does
   * `ask({...}).then(run)` and discards the result, so a thenable that hands
   * back a caught chain is the whole seam. */
  const swallowed = [];
  h.sandbox.RATrackerDialog.confirm = () => ({
    then: (run) => Promise.resolve(true).then(run).catch((err) => swallowed.push(err)),
  });

  h.click("[data-del='m2']");
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(swallowed, [boom], "the delete must have reached forgetVisual and thrown there");

  // The delete really did run: without this the assertion below is vacuous.
  assert.ok(h.removed.includes("log_m2"), "the log key must have been removed");
  assert.ok(
    !h.storage.matches.some((m) => m.id === "m2"),
    "m2 is still in the stored matches array while log_m2 has already been deleted - " +
      "the next reload brings the match back with its log and cards gone for good"
  );
  assert.deepEqual(h.warnings, []);
});

test("clearing everything drops the recordings with the matches", async () => {
  /* The one that has to hold together: data-io.js empties the array in memory,
   * tells the Replays view to forget every recording, and only then writes. A
   * throw between the first and the last leaves memory wiped and storage full -
   * a half-done Clear all, which looks like it worked until the next reload. */
  const h = boot({ matches: HISTORY, replays: [replayRecord({})], storage: { shares: [], log_m1: { id: "m1", log: [] } } });

  h.click("#clearAll");
  await h.quiet("clearing everything");

  assert.equal(h.sandbox.RATrackerLegacy.matches().length, 0, "memory must be cleared");
  assert.deepEqual([...h.storage.matches], [], "and storage with it, or the next reload brings them back");
  assert.ok(h.removed.includes("log_m1"), "the separate log keys go too");
  assert.ok(h.removed.includes("shares"), "each share record holds a decryption key");
  assert.ok(
    h.sent.some((m) => m.type === "ra:visual:clear"),
    "the service worker must be told to drop every recording"
  );
  assert.equal(h.document.querySelector("#visualPanel").hidden, true);
});

test("archiving and clearing keeps what the archive file does not hold", async () => {
  const h = boot({ matches: HISTORY, storage: { shares: [] } });
  h.click("#archiveClear");
  await h.quiet("archive and clear");

  assert.ok(
    h.asked.some((d) => /Clear everything from the extension/.test(d.title || "")),
    "the archive confirm must have been reached"
  );
  assert.deepEqual([...h.storage.matches], []);
  assert.ok(h.toasts.some((t) => /Cleared|cleared/.test(t.message)));
});

test("an archive-and-clear that fails part way never strips a match it left behind", async () => {
  /* data-io.js had the delete path's shape: remove every clearable key, then
   * forgetAllVisual, then write the array. A throw in the middle left `matches`
   * holding every archived match with its log, its cards and its share records
   * already gone. The archive file makes that recoverable rather than fatal,
   * which is the only reason it is not the same severity - not a reason to keep
   * the order. */
  const h = boot({ matches: HISTORY, storage: { shares: [], log_m1: { id: "m1", log: [] } } });

  const boom = new Error("Extension context invalidated.");
  h.sandbox.RATrackerViewReplays.forgetAllVisual = () => {
    throw boom;
  };
  const swallowed = [];
  h.sandbox.RATrackerDialog.confirm = () => ({
    then: (run) => Promise.resolve(true).then(run).catch((err) => swallowed.push(err)),
  });

  h.click("#archiveClear");
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));

  assert.deepEqual(swallowed, [boom], "the clear must have reached forgetAllVisual and thrown there");
  assert.ok(h.removed.includes("log_m1"), "the log keys must have been removed");
  assert.deepEqual(
    h.storage.matches.map((m) => m.id),
    [],
    "the archived matches are still in storage with their logs and share records deleted"
  );
});

// ---- backups -------------------------------------------------------------

test("an overdue daily backup writes a file", async () => {
  /* backups.js builds the file out of data-io.js: the bundle, the datestamp in
   * its name, and - when the Downloads folder is not ours - data-io's own
   * download. All three are reached off the global at call time. */
  const h = boot({
    matches: HISTORY,
    settings: { autoBackup: true, lastBackup: 1 },
    downloadsGranted: true,
  });
  await h.quiet("the daily backup");

  assert.equal(h.downloads.length, 1, "an overdue backup must be written");
  assert.match(h.downloads[0].filename, /^riftatlas-backups\/matches-\d{4}-\d{2}-\d{2}\.json$/);
  assert.ok(h.storage.settings.lastBackup > 1, "and the date recorded");
});

test("declining the downloads permission still saves the bundle", async () => {
  const h = boot({
    matches: HISTORY,
    settings: { autoBackup: false, lastBackup: 0 },
    downloadsGranted: false,
    downloadsGrantable: false,
  });
  assert.equal(h.document.querySelector("#backupBanner").hidden, false, "the nag must be showing");

  h.click("#bannerBackup");
  h.runTimers();
  await h.quiet("the backup fallback");

  assert.equal(h.downloads.length, 0, "nothing may be written to Downloads without the permission");
  assert.equal(h.document.querySelector("#backupBanner").hidden, true);

  // The fallback is the Export button's own save, filename and all.
  const h2 = boot({ matches: HISTORY, settings: { autoBackup: false, lastBackup: 0 } });
  h2.change("#autoBackup", { checked: true });
  await h2.quiet("declining the permission");
  assert.ok(
    h2.toasts.some((t) => /Downloads permission/.test(t.message)),
    "declining must say so, which is a toast reached through notify.js"
  );
  assert.equal(h2.document.querySelector("#autoBackup").checked, false);
});

// ---- what the page says --------------------------------------------------

test("every toast a control can raise reaches a real function", async () => {
  /* `say` is destructured off RATrackerNotify at evaluation time in four files
   * at once, so a rename there is undefined in all of them and throws at the
   * first message - which is the first time anything at all is said to the
   * user. Nothing about that is visible until it happens. */
  const h = boot({ matches: [], storage: { shares: [] } });
  h.click("#archiveClear");
  assert.ok(h.toasts.some((t) => /no matches to archive/.test(t.message)));
  await h.quiet("saying there is nothing to archive");

  const h2 = boot({ matches: [match({ id: "m1", deckName: "Named" })], storage: { shares: [] } });
  h2.click("#bulkLabel");
  assert.ok(h2.toasts.some((t) => /already has a deck name/.test(t.message)));
  await h2.quiet("saying everything is already labelled");
});

test("a storage change repaints the page", async () => {
  const h = boot({ matches: HISTORY, storage: { shares: [] } });
  h.storage.matches = HISTORY.concat(match({ id: "m4", startedAt: "2026-02-02T10:00:00.000Z" }));

  h.storageChanged({ matches: { newValue: h.storage.matches, oldValue: HISTORY } });
  h.storageChanged({ shares: { newValue: [], oldValue: [] } });
  await h.quiet("a storage change");

  assert.equal(h.sandbox.RATrackerLegacy.matches().length, 4, "the reload must reach the array");
  assert.equal(h.document.querySelector("#tGames").textContent, "4");
});
