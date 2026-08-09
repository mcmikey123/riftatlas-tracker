/* Rift Atlas Stats Tracker - IndexedDB wrapper for visual replays.
 * Caches the open handle; steps aside on blocked/versionchange so a
 * stale connection can never wedge the service worker. */
(function (root) {
  "use strict";

  const DB_NAME = "ra-visual";
  const DB_VERSION = 1;
  const STORE_DEFS = {
    replays: { keyPath: "matchId" },
    chunks: { keyPath: ["matchId", "seq"] },
    assets: { keyPath: "hash" },
  };

  let dbPromise = null;

  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of Object.keys(STORE_DEFS)) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, STORE_DEFS[name]);
        }
      };
      req.onblocked = () => {
        dbPromise = null;
        reject(new Error("ra-visual: database open blocked by another connection"));
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another connection wants to upgrade: close so it isn't blocked,
        // and drop the cache so the next call reopens a fresh handle.
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }

  async function withStore(storeName, mode, run) {
    const db = await openDb();
    return run(db.transaction(storeName, mode).objectStore(storeName));
  }

  const put = (storeName, value) => withStore(storeName, "readwrite", (s) => wrap(s.put(value)));
  const get = (storeName, key) => withStore(storeName, "readonly", (s) => wrap(s.get(key)));
  const getAll = (storeName, query) => withStore(storeName, "readonly", (s) => wrap(s.getAll(query)));
  const del = (storeName, key) => withStore(storeName, "readwrite", (s) => wrap(s.delete(key)));

  async function clearMatch(matchId) {
    const db = await openDb();
    const tx = db.transaction(["replays", "chunks"], "readwrite");
    tx.objectStore("replays").delete(matchId);
    const range = IDBKeyRange.bound([matchId, -Infinity], [matchId, Infinity]);
    const cursorReq = tx.objectStore("chunks").openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  root.RATrackerIdb = { openDb, put, get, getAll, del, clearMatch };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerIdb;
}
