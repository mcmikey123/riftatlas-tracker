"use strict";

/* The official replays on disk: a stored game reads back as the JSON it was,
 * a deleted one is not fetched again while its server copy lives, and the
 * keep count drops the oldest games first. */
const test = require("node:test");
const assert = require("node:assert/strict");

const { createOfficialStore } = require("../store/official-store.js");

function fakeIdb() {
  const stores = { official: new Map(), officialData: new Map() };
  return {
    stores,
    async put(name, value) {
      stores[name].set(value.gameKey, value);
    },
    async get(name, key) {
      return stores[name].get(key);
    },
    async getAll(name) {
      return [...stores[name].values()];
    },
    async del(name, key) {
      stores[name].delete(key);
    },
  };
}

const identity = async (bytes) => bytes;
const summary = (key, endedAt, expiresAt) => ({ gameKey: key, endedAt, expiresAt });

function store() {
  const idb = fakeIdb();
  return { idb, s: createOfficialStore({ idb, compress: identity, decompress: identity }) };
}

test("a stored replay reads back as the text it was, and lists without its body", async () => {
  const { s } = store();
  await s.put(summary("k1", 1, Date.now() + 1000), '{"a":1}');
  assert.equal(await s.getText("k1"), '{"a":1}');
  const rows = await s.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].summary.gameKey, "k1");
  assert.equal("data" in rows[0], false);
  assert.equal(await s.getText("nope"), null);
});

test("a deleted replay is gone from the list but still known to the poll", async () => {
  const { s } = store();
  await s.put(summary("k1", 1, Date.now() + 60000), "{}");
  await s.remove("k1");
  assert.deepEqual(await s.list(), []);
  assert.equal(await s.getText("k1"), null);
  assert.deepEqual(await s.keys(), ["k1"], "the next poll must not download it back");
});

test("deleting a tombstone again keeps the expiry it carries", async () => {
  const { s, idb } = store();
  const expiresAt = Date.now() + 60000;
  await s.put(summary("k1", 1, expiresAt), "{}");
  await s.remove("k1");
  await s.remove("k1");
  assert.equal(idb.stores.official.get("k1").expiresAt, expiresAt);
});

test("a tombstone is dropped once the server copy has expired", async () => {
  const { s, idb } = store();
  await s.put(summary("live", 1, Date.now() + 60000), "{}");
  await s.put(summary("spent", 1, Date.now() - 1), "{}");
  await s.remove("live");
  await s.remove("spent");
  await s.gc(25);
  assert.deepEqual([...idb.stores.official.keys()], ["live"]);
});

test("retention keeps the newest games by when they ended", async () => {
  const { s, idb } = store();
  await s.put(summary("old", 100, null), "{}");
  await s.put(summary("new", 300, null), "{}");
  await s.put(summary("mid", 200, null), "{}");
  await s.gc(2);
  assert.deepEqual((await s.list()).map((r) => r.gameKey).sort(), ["mid", "new"]);
  assert.equal(idb.stores.officialData.has("old"), false);
});
