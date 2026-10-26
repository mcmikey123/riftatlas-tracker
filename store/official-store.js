/* Rift Atlas Stats Tracker - the official replays on disk
 *
 * One row per game in two stores: `official` holds the summary the history
 * listed it with, `officialData` the replay JSON, compressed. Listing reads
 * the first only, so the dashboard's one query for the whole history never
 * pulls a replay body through a message.
 *
 * The body is written before the summary and deleted after it, so a summary on
 * disk always has its body behind it: an interrupted write leaves bytes nothing
 * lists, never a listed replay that will not open.
 *
 * Deleting leaves a tombstone - the key and when the server copy expires - and
 * the body goes. Without it the next poll would find the game missing and
 * download it straight back, which is exactly what deleting a match was meant
 * to prevent. Tombstones are dropped once the server copy is gone too.
 *
 * Retention reuses the visual replays' keep count. An official replay holds
 * the opponent's hand and name the same way a recording holds their board,
 * and one number for "how many games to keep the footage of" is the one the
 * owner already sets.
 */
(function (root) {
  "use strict";

  function createOfficialStore({ idb, compress, decompress }) {
    const encode = (text) => new TextEncoder().encode(text);
    const decode = (bytes) => new TextDecoder().decode(bytes);

    async function put(summary, text) {
      const data = await compress(encode(text));
      await idb.put("officialData", { gameKey: summary.gameKey, data });
      await idb.put("official", {
        gameKey: summary.gameKey,
        summary,
        rawBytes: text.length,
        compressedBytes: data.byteLength,
        storedAt: Date.now(),
      });
    }

    const all = async () => (await idb.getAll("official")) || [];

    /** Every stored replay's row, tombstones left out. */
    const list = async () => (await all()).filter((r) => !r.deletedAt);

    /** Every key the poll should not fetch: stored, or deleted on purpose. */
    const keys = async () => (await all()).map((r) => r.gameKey);

    /** The replay JSON as text, or null when this game has none on disk. */
    async function getText(gameKey) {
      const row = await idb.get("officialData", gameKey);
      return row && row.data ? decode(await decompress(row.data)) : null;
    }

    // Past this, a tombstone with no recorded expiry is assumed to outlive the
    // server copy it guards against.
    const TOMBSTONE_FALLBACK_MS = 2 * 24 * 60 * 60 * 1000;

    async function remove(gameKey) {
      const row = await idb.get("official", gameKey);
      const expiresAt = (row && row.summary && row.summary.expiresAt) || null;
      await idb.put("official", { gameKey, deletedAt: Date.now(), expiresAt });
      await idb.del("officialData", gameKey);
    }

    const endOf = (r) => (r.summary && r.summary.endedAt) || r.storedAt || 0;
    const tombstoneDone = (r, now) =>
      (r.expiresAt || r.deletedAt + TOMBSTONE_FALLBACK_MS) < now;

    /** Keep the newest `keep` games, by when they ended, and drop spent tombstones. */
    async function gc(keep) {
      const now = Date.now();
      const rows = await all();
      for (const r of rows) {
        if (r.deletedAt && tombstoneDone(r, now)) await idb.del("official", r.gameKey);
      }
      const live = rows.filter((r) => !r.deletedAt).sort((a, b) => endOf(b) - endOf(a));
      for (const r of live.slice(keep)) await remove(r.gameKey);
    }

    return { put, list, keys, getText, remove, gc };
  }

  root.RATrackerOfficialStore = { createOfficialStore };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerOfficialStore;
}
