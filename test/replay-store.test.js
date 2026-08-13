const test = require("node:test");
const assert = require("node:assert/strict");

const { createReplayStore, BATCH_MAX_RAW, BATCH_MAX_MS } = require("../store/replay-store.js");

const decode = (bytes) => new TextDecoder().decode(bytes);
const encode = (text) => new TextEncoder().encode(text);

const hash = async (t) => "h" + t.length;
const identity = async (bytes) => bytes;

const BIG_CSS = ".big{color:red}".padEnd(5000, "/*x*/");

// In-memory stand-in for store/idb.js. Composite chunk keys are flattened to a
// string so a plain Map can hold them.
function fakeIdb() {
  const stores = { replays: new Map(), chunks: new Map(), assets: new Map() };
  const keyOf = {
    replays: (v) => v.matchId,
    chunks: (v) => v.matchId + "|" + v.seq,
    assets: (v) => v.hash,
  };
  return {
    stores,
    async put(name, value) {
      stores[name].set(keyOf[name](value), value);
    },
    async get(name, key) {
      return stores[name].get(Array.isArray(key) ? key.join("|") : key);
    },
    async getAll(name) {
      return [...stores[name].values()];
    },
    async del(name, key) {
      stores[name].delete(Array.isArray(key) ? key.join("|") : key);
    },
    async clearMatch(matchId) {
      stores.replays.delete(matchId);
      for (const [key, chunk] of stores.chunks) {
        if (chunk.matchId === matchId) stores.chunks.delete(key);
      }
    },
    async clearAll() {
      for (const name of Object.keys(stores)) stores[name].clear();
    },
  };
}

function makeStore(idb, overrides) {
  return createReplayStore(
    Object.assign({ idb, compress: identity, decompress: identity, hash }, overrides)
  );
}

const meta = (startedAt = 1000) => ({
  startedAt,
  viewport: { w: 800, h: 600, dpr: 2 },
  href: "https://example.test/",
});

// n plain incremental (type 3) events, ids starting at `base`.
const events = (n, base) =>
  Array.from({ length: n }, (_, i) => ({
    type: 3,
    timestamp: 2000 + base + i,
    data: { source: 3, id: base + i, y: i * 10 },
  }));

const fullSnapshot = (cssText) => ({
  type: 2,
  timestamp: 1500,
  data: {
    node: {
      type: 0,
      id: 1,
      childNodes: [
        { type: 2, tagName: "style", attributes: { _cssText: cssText }, id: 2, childNodes: [] },
      ],
    },
  },
});

const chunkAt = (idb, matchId, seq) => idb.stores.chunks.get(matchId + "|" + seq);
const eventsIn = (chunk) => JSON.parse(decode(chunk.bytes));

// Runs `body` with Date.now under the test's control, for the age-based roll.
async function withClock(start, body) {
  const real = Date.now;
  let now = start;
  Date.now = () => now;
  try {
    await body((ms) => { now += ms; });
  } finally {
    Date.now = real;
  }
}

test("rolls the open chunk once it has been open for BATCH_MAX_MS", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);

  await withClock(1000000, async (advance) => {
    await store.start("m1", meta());
    await store.append("m1", events(2, 1), 1000);
    assert.equal(idb.stores.chunks.size, 1);

    // Well under BATCH_MAX_RAW, so only the chunk's age can close it.
    advance(BATCH_MAX_MS);
    await store.append("m1", events(3, 10), 1000);
  });

  assert.equal(idb.stores.chunks.size, 2);
  assert.equal(eventsIn(chunkAt(idb, "m1", 0)).length, 2);
  assert.equal(chunkAt(idb, "m1", 1).firstEventIdx, 2);
  assert.equal(eventsIn(chunkAt(idb, "m1", 1)).length, 3);
});

test("start then one append writes one replay record and one chunk", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);

  await store.start("m1", meta());
  assert.equal(idb.stores.replays.size, 1);
  assert.equal(idb.stores.chunks.size, 0);

  await store.append("m1", events(2, 1), 1000);
  assert.equal(idb.stores.replays.size, 1);
  assert.equal(idb.stores.chunks.size, 1);

  const record = idb.stores.replays.get("m1");
  assert.equal(record.state, "recording");
  assert.equal(record.chunkCount, 1);
  assert.deepEqual(record.viewport, { w: 800, h: 600, dpr: 2 });
  assert.equal(eventsIn(chunkAt(idb, "m1", 0)).length, 2);
});

test("accumulates into one chunk until a batch would cross BATCH_MAX_RAW", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);
  await store.start("m1", meta());

  await store.append("m1", events(3, 1), 200 * 1024);
  await store.append("m1", events(2, 10), 40 * 1024);
  assert.equal(idb.stores.chunks.size, 1);
  assert.equal(chunkAt(idb, "m1", 0).firstEventIdx, 0);
  assert.equal(eventsIn(chunkAt(idb, "m1", 0)).length, 5);

  // 240KB open + 40KB more crosses BATCH_MAX_RAW, so this batch opens seq 1.
  await store.append("m1", events(4, 20), 40 * 1024);
  assert.equal(idb.stores.chunks.size, 2);
  assert.equal(eventsIn(chunkAt(idb, "m1", 0)).length, 5);

  const second = chunkAt(idb, "m1", 1);
  assert.equal(second.firstEventIdx, 5);
  assert.equal(eventsIn(second).length, 4);
  assert.equal(idb.stores.replays.get("m1").chunkCount, 2);
});

test("reports totalCompressedBytes as the sum of every chunk's bytes", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);
  await store.start("m1", meta());

  const first = await store.append("m1", events(3, 1), 200 * 1024);
  assert.equal(first.totalCompressedBytes, chunkAt(idb, "m1", 0).bytes.length);

  const second = await store.append("m1", events(4, 20), 100 * 1024);
  const sum = [...idb.stores.chunks.values()].reduce((n, c) => n + c.bytes.length, 0);
  assert.equal(idb.stores.chunks.size, 2);
  assert.equal(second.compressedBytes, chunkAt(idb, "m1", 1).bytes.length);
  assert.equal(second.totalCompressedBytes, sum);
});

test("stop with a truncating reason records the state and the turn", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);
  await store.start("m1", meta());
  await store.append("m1", events(2, 1), 1000);

  await store.stop("m1", { reason: "budget", truncatedAtTurn: 9 });

  const record = idb.stores.replays.get("m1");
  assert.equal(record.state, "truncated");
  assert.equal(record.truncatedAtTurn, 9);
  assert.equal(record.incomplete, true);
  assert.equal(typeof record.endedAt, "number");
});

test("stop at the end of a match records completion", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);
  await store.start("m1", meta());
  await store.append("m1", events(2, 1), 1000);

  await store.stop("m1", { reason: "end" });

  const record = idb.stores.replays.get("m1");
  assert.equal(record.state, "complete");
  assert.equal(record.truncatedAtTurn, null);
  assert.equal(record.incomplete, false);
  assert.equal(typeof record.endedAt, "number");
});

test("get returns every appended event with css rehydrated", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);
  const appended = [
    ...events(2, 1),
    fullSnapshot(BIG_CSS),
    ...events(3, 20),
    fullSnapshot(BIG_CSS),
  ];

  await store.start("m1", meta());
  await store.append("m1", appended.slice(0, 3), 200 * 1024);
  await store.append("m1", appended.slice(3), 100 * 1024);

  // The repeated sheet is stored once, out of line, and referenced by the replay.
  assert.equal(idb.stores.assets.size, 1);
  assert.equal(idb.stores.assets.get("h" + BIG_CSS.length).text, BIG_CSS);
  assert.deepEqual(idb.stores.replays.get("m1").cssRefs, ["h" + BIG_CSS.length]);
  assert.equal(decode(chunkAt(idb, "m1", 0).bytes).includes(BIG_CSS), false);

  const result = await store.get("m1");
  assert.deepEqual(result.events, appended);
  assert.equal(result.meta.matchId, "m1");
  assert.equal(result.meta.truncatedAtChunk, undefined);
  assert.equal(await store.get("nope"), null);
});

test("get recovers what it can when a chunk will not decode", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);
  await store.start("m1", meta());
  await store.append("m1", events(2, 1), 200 * 1024);
  await store.append("m1", events(3, 20), 100 * 1024);
  await store.append("m1", events(1, 40), 200 * 1024);
  assert.equal(idb.stores.chunks.size, 3);

  chunkAt(idb, "m1", 1).bytes = encode("{not json");

  const result = await store.get("m1");
  assert.deepEqual(result.events, events(2, 1));
  assert.equal(result.meta.truncatedAtChunk, 1);
});

test("gc keeps the newest replays and deletes the rest with their chunks", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);

  for (const [matchId, startedAt] of [["a", 100], ["b", 400], ["c", 200], ["d", 300]]) {
    await store.start(matchId, meta(startedAt));
    await store.append(matchId, [fullSnapshot(BIG_CSS), ...events(2, 1)], 1000);
    await store.stop(matchId, { reason: "end" });
  }
  assert.equal(idb.stores.chunks.size, 4);

  const deleted = await store.gc(2);

  assert.equal(deleted, 2);
  assert.deepEqual([...idb.stores.replays.keys()].sort(), ["b", "d"]);
  assert.deepEqual([...idb.stores.chunks.keys()].sort(), ["b|0", "d|0"]);
  // Assets are shared between replays, so gc must never touch them.
  assert.equal(idb.stores.assets.size, 1);
  assert.equal((await store.list()).length, 2);
  assert.equal(await store.gc(10), 0);
});

// Chunks for one match, oldest first, with the events each one holds.
const chunksOf = (idb, matchId) =>
  [...idb.stores.chunks.values()]
    .filter((c) => c.matchId === matchId)
    .sort((a, b) => a.seq - b.seq);

// Every chunk's firstEventIdx must be exactly how many events precede it, or
// the viewer seeks to the wrong frame.
function assertChain(idb, matchId, expected) {
  const chunks = chunksOf(idb, matchId);
  const seen = [];
  for (const chunk of chunks) {
    assert.equal(chunk.firstEventIdx, seen.length, `firstEventIdx of seq ${chunk.seq}`);
    for (const event of eventsIn(chunk)) seen.push(event);
  }
  assert.deepEqual(seen, expected);
  assert.equal(idb.stores.replays.get(matchId).stats.eventCount, expected.length);
  assert.deepEqual(chunks.map((c) => c.seq), chunks.map((_, i) => i));
}

// The recorder flushes from a timer and from a size threshold without awaiting
// the previous reply, so two appends for one match overlap routinely.
test("concurrent appends keep every event, in order, with an intact chain", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);
  await store.start("m1", meta());

  const first = events(3, 1);
  const second = events(4, 100);
  await Promise.all([
    store.append("m1", first, 1000),
    store.append("m1", second, 1000),
  ]);

  assertChain(idb, "m1", [...first, ...second]);
  assert.deepEqual((await store.get("m1")).events, [...first, ...second]);
});

test("concurrent appends that roll the chunk lose nothing across the boundary", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);
  await store.start("m1", meta());

  const batches = [events(2, 1), events(3, 100), events(4, 200)];
  // Each batch is over half of BATCH_MAX_RAW, so the second and third both
  // cross it and open a new chunk.
  await Promise.all(batches.map((batch) => store.append("m1", batch, 0.6 * BATCH_MAX_RAW)));

  assert.equal(chunksOf(idb, "m1").length, 3);
  assertChain(idb, "m1", batches.flat());
  assert.equal(idb.stores.replays.get("m1").chunkCount, 3);
});

// The recorder sends its last batch and then stops immediately; a stop that
// read the record before that append wrote it would revert cssRefs, and the
// final keyframe would rehydrate to an empty stylesheet.
test("a stop racing the last append cannot revert it", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);
  await store.start("m1", meta());

  const last = [fullSnapshot(BIG_CSS), ...events(2, 1)];
  await Promise.all([
    store.append("m1", last, 1000),
    store.stop("m1", { reason: "end" }),
  ]);

  const record = idb.stores.replays.get("m1");
  assert.deepEqual(record.cssRefs, ["h" + BIG_CSS.length]);
  assert.equal(record.state, "complete");
  assert.equal(record.stats.eventCount, 3);
  assert.equal(record.chunkCount, 1);

  // The whole point: the last keyframe still carries its stylesheet.
  assert.deepEqual((await store.get("m1")).events, last);
});

test("a kill switch that latches before the first turn still files as truncated", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);

  for (const reason of ["perf-kill", "restart", "budget"]) {
    await store.start(reason, meta());
    await store.append(reason, events(1, 1), 1000);
    // No turn was ever marked, so truncatedAtTurn cannot carry the state.
    await store.stop(reason, { reason, truncatedAtTurn: null });

    const record = idb.stores.replays.get(reason);
    assert.equal(record.state, "truncated", reason);
    assert.equal(record.incomplete, true, reason);
  }

  await store.start("m2", meta());
  await store.stop("m2", { reason: "navigate" });
  assert.equal(idb.stores.replays.get("m2").state, "stopped");
});

test("stop records the recorder's error message, and only when it errored", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);

  await store.start("m1", meta());
  await store.stop("m1", { reason: "error", error: "rrweb threw: bad node" });
  assert.equal(idb.stores.replays.get("m1").state, "error");
  assert.equal(idb.stores.replays.get("m1").error, "rrweb threw: bad node");

  await store.start("m2", meta());
  await store.stop("m2", { reason: "end", error: "not an error" });
  assert.equal(idb.stores.replays.get("m2").error, null);

  await store.start("m3", meta());
  await store.stop("m3", { reason: "error" });
  assert.equal(idb.stores.replays.get("m3").error, null);
});

test("gc reaps assets no surviving replay references", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);
  // Same content hash for the shared sheet, a distinct one per redeploy.
  const OLD_CSS = BIG_CSS + "/*old*/";

  await store.start("old", meta(100));
  await store.append("old", [fullSnapshot(OLD_CSS)], 1000);
  await store.stop("old", { reason: "end" });

  await store.start("new", meta(400));
  await store.append("new", [fullSnapshot(BIG_CSS)], 1000);
  await store.stop("new", { reason: "end" });
  assert.equal(idb.stores.assets.size, 2);

  assert.equal(await store.gc(1), 1);

  assert.deepEqual([...idb.stores.assets.keys()], ["h" + BIG_CSS.length]);
  // The survivor still plays back with its stylesheet intact.
  assert.deepEqual((await store.get("new")).events, [fullSnapshot(BIG_CSS)]);
});

// An append writes its assets before it patches the record with the refs, so a
// gc landing in that window must not mistake them for orphans.
test("gc leaves assets a mid-flight append has written but not yet referenced", async () => {
  const idb = fakeIdb();
  const OLD_CSS = BIG_CSS + "/*old*/";
  let gate = null;
  const store = makeStore(idb, { compress: async (bytes) => (gate ? gate.then(() => bytes) : bytes) });

  await store.start("old", meta(100));
  await store.append("old", [fullSnapshot(OLD_CSS)], 1000);
  await store.stop("old", { reason: "end" });

  await store.start("live", meta(400));
  let release;
  gate = new Promise((r) => { release = r; });
  const inflight = store.append("live", [fullSnapshot(BIG_CSS)], 1000);
  await new Promise((r) => setTimeout(r, 0));
  // The asset is on disk; the record still has no ref to it.
  assert.equal(idb.stores.assets.size, 2);
  assert.deepEqual(idb.stores.replays.get("live").cssRefs, []);

  assert.equal(await store.gc(1), 1);
  release();
  await inflight;

  assert.deepEqual([...idb.stores.assets.keys()], ["h" + BIG_CSS.length]);
  assert.deepEqual((await store.get("live")).events, [fullSnapshot(BIG_CSS)]);
});

/* Parks compress so a test can land another operation inside an append, in the
 * window between its asset write and its chunk write. `arm()` holds the next
 * append there and returns the release; appends before it run straight through. */
function pausableCompress() {
  let gate = null;
  return {
    compress: async (bytes) => (gate ? gate.then(() => bytes) : bytes),
    arm() {
      let release;
      gate = new Promise((r) => { release = r; });
      return () => { gate = null; release(); };
    },
  };
}

// A tick, so an armed append reaches its parked compress before the test moves.
const parked = () => new Promise((r) => setTimeout(r, 0));

/* Deleting a replay mid-recording is a normal thing to do from the dashboard.
 * Unserialized it leaves the chunk the append was writing behind with no
 * `replays` row to reach it from - gc walks records - and the append's patch
 * puts that row back with its chunks already gone, which the dashboard reads as
 * a playable replay that opens to nothing. */
test("a delete landing mid-append leaves neither its chunks nor a phantom record", async () => {
  const idb = fakeIdb();
  const paused = pausableCompress();
  const store = makeStore(idb, { compress: paused.compress });

  await store.start("m1", meta());
  await store.append("m1", events(2, 1), 1000);

  const release = paused.arm();
  const inflight = store.append("m1", [fullSnapshot(BIG_CSS), ...events(3, 100)], 1000);
  await parked();
  assert.equal(idb.stores.assets.size, 1, "the parked append has written its asset");

  const removed = store.remove("m1");
  release();
  await inflight;
  await removed;

  assert.deepEqual([...idb.stores.chunks.keys()], []);
  assert.equal(idb.stores.replays.get("m1"), undefined);
  assert.deepEqual([...idb.stores.assets.keys()], []);
});

// The session answers from memory without consulting the record, so a delete
// that left it in place would have the recorder writing chunks for a match that
// no longer exists - rows no cleanup path can ever see again.
test("a delete drops the session, so a later append cannot resurrect its chunks", async () => {
  const idb = fakeIdb();
  const store = makeStore(idb);

  await store.start("m1", meta());
  await store.append("m1", [fullSnapshot(BIG_CSS), ...events(2, 1)], 1000);
  await store.remove("m1");

  await assert.rejects(store.append("m1", events(3, 100), 1000), /append before start/);
  assert.equal(idb.stores.chunks.size, 0);
  assert.equal(idb.stores.replays.size, 0);
  assert.equal(idb.stores.assets.size, 0);
});

test("gc evicts a match whose append is still in flight, chunks included", async () => {
  const idb = fakeIdb();
  const OLD_CSS = BIG_CSS + "/*old*/";
  const paused = pausableCompress();
  const store = makeStore(idb, { compress: paused.compress });

  await store.start("old", meta(100));
  await store.append("old", [fullSnapshot(OLD_CSS)], 1000);
  await store.start("new", meta(400));
  await store.append("new", [fullSnapshot(BIG_CSS)], 1000);

  const release = paused.arm();
  const inflight = store.append("old", events(3, 1), 1000);
  await parked();

  const collected = store.gc(1);
  release();
  await inflight;

  assert.equal(await collected, 1);
  assert.deepEqual([...idb.stores.replays.keys()], ["new"]);
  assert.deepEqual(chunksOf(idb, "old"), []);
  assert.deepEqual([...idb.stores.assets.keys()], ["h" + BIG_CSS.length]);
  assert.deepEqual((await store.get("new")).events, [fullSnapshot(BIG_CSS)]);
});

test("clearAll empties every store and leaves no session writing into it", async () => {
  const idb = fakeIdb();
  const paused = pausableCompress();
  const store = makeStore(idb, { compress: paused.compress });

  await store.start("done", meta(100));
  await store.append("done", [fullSnapshot(BIG_CSS)], 1000);
  await store.stop("done", { reason: "end" });

  await store.start("live", meta(400));
  const release = paused.arm();
  const inflight = store.append("live", events(2, 1), 1000);
  await parked();

  const cleared = store.clearAll();
  release();
  await inflight;
  await cleared;

  assert.equal(idb.stores.replays.size, 0);
  assert.equal(idb.stores.chunks.size, 0);
  assert.equal(idb.stores.assets.size, 0);
  // The live recording is gone with the database, not still holding a session.
  await assert.rejects(store.append("live", events(1, 100), 1000), /append before start/);
  assert.equal(idb.stores.chunks.size, 0);
});

/* The dashboard reads replays itself now, against the same IndexedDB the worker
 * writes to, because a whole replay does not reliably fit through
 * chrome.runtime.sendMessage. It builds its store with `idb` and `decompress`
 * only - see the reader in dashboard/legacy.js - and deliberately withholds the
 * write-side dependencies so a mistaken start/append/stop throws there rather
 * than writing behind the back of the worker that believes it owns the
 * recording.
 *
 * That makes "get() needs neither compress nor hash" a contract between two
 * files, and nothing else pins it. Give get() a reason to hash an asset or
 * compress anything and every test here still passes while the dashboard breaks
 * at runtime - which is the exact failure that moving the read fixed. */
test("get() reads with no compress and no hash, which is all the dashboard injects", async () => {
  const idb = fakeIdb();
  const writer = makeStore(idb);
  await writer.start("m1", meta());
  await writer.append("m1", [{ type: 2, data: { node: { attributes: {} } } }], 10);
  await writer.stop("m1", { reason: "end" });

  // Exactly what dashboard/legacy.js constructs: no compress, no hash.
  const reader = createReplayStore({ idb, decompress: identity });
  const replay = await reader.get("m1");

  assert.ok(replay, "a stored replay must be readable without the write-side deps");
  assert.equal(replay.events.length, 1);
  assert.equal(replay.meta.matchId, "m1");
});
