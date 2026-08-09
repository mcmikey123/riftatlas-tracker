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

test("exposes the locked batch constants", () => {
  assert.equal(BATCH_MAX_RAW, 256 * 1024);
  assert.equal(BATCH_MAX_MS, 5000);
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
