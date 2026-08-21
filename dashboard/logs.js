/* Rift Atlas Stats Tracker - bulk game-log reads
 *
 * Game logs live under their own log_<id> keys precisely so the match array
 * stays lean, which means any analysis that wants MANY logs - the going-first
 * backfill, the battlefield table - has to go and fetch them. That fetch lives
 * here, in one place, read-only.
 *
 * In archive mode there is no storage to read: the file's logs were poured
 * into legacy.js's log cache when the archive opened, so they are taken from
 * there instead. Which mode applies, and where the cache is, are the CALLER'S
 * facts - passed in as `deps` - so this file stays pure enough to test and
 * ignorant of who owns the archive.
 */
(function (root) {
  "use strict";

  /**
   * id -> log lines, for every id that has any. Never rejects.
   *
   * @param {string[]} ids - match ids to fetch logs for.
   * @param {{readOnly: function(): boolean, cachedLog: function(string): ?Array}} deps
   *   `readOnly` says an archive is open; `cachedLog` is its log cache.
   */
  function readLogs(ids, deps) {
    const d = deps || {};
    const wanted = [...new Set(ids || [])].filter(Boolean);
    if (d.readOnly && d.readOnly()) {
      const out = new Map();
      for (const id of wanted) {
        const log = d.cachedLog ? d.cachedLog(id) : null;
        if (Array.isArray(log) && log.length) out.set(id, log);
      }
      return Promise.resolve(out);
    }
    return new Promise((resolve) => {
      const keys = wanted.map((id) => "log_" + id);
      if (!keys.length) return resolve(new Map());
      try {
        chrome.storage.local.get(keys, (data) => {
          const out = new Map();
          for (const id of wanted) {
            const r = data && data["log_" + id];
            if (r && Array.isArray(r.log) && r.log.length) out.set(id, r.log);
          }
          resolve(out);
        });
      } catch (_) {
        resolve(new Map());
      }
    });
  }

  root.RATrackerLogs = { readLogs };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerLogs;
}
