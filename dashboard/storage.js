/* Rift Atlas Stats Tracker - the dashboard's only writer
 *
 * Every write to chrome.storage.local goes through here, for one reason:
 * ARCHIVE MODE.
 *
 * When an archive file is open the dashboard renders that file's matches from
 * memory. The in-memory array is no longer the user's history - it is the
 * contents of a file they are merely looking at. Anything that writes that
 * array back replaces a real history with a file's, and there is no undo,
 * because the write is the only copy.
 *
 * The old code had a guard for this in `persist()`, and six write sites that
 * bypassed it and called chrome.storage.local.set({ matches: all }) directly,
 * each protected only by a readOnly() check at its own caller. That held, but
 * it held by hand: every future view had to remember. This redesign adds a
 * Series view full of new mutating controls - a selection bar, "Group as a
 * Bo3", "Set deck for all N…", "Remove from series", and a result editor on
 * every expanded sub-row - in a view that renders in archive mode. Relying on
 * each of those to remember is how the archive eventually gets written.
 *
 * So the guard moves here, once, and it THROWS rather than returning quietly.
 * A silent no-op is indistinguishable from a successful write at the call site
 * and would show a success message over a write that never happened; a throw
 * stops the handler and says so. Callers that legitimately do nothing in
 * archive mode still check `isReadOnly()` first - this is the backstop, not
 * the first line of defence.
 *
 * Not pure and therefore not unit tested, per the project rule that browser
 * and network code stays small and obviously correct instead. What IS asserted
 * is that nothing else writes: see test/storage-writes.test.js.
 */
(function (root) {
  "use strict";

  let readOnly = false;

  /** Told by whoever opens or closes an archive. */
  const setReadOnly = (v) => {
    readOnly = !!v;
  };
  const isReadOnly = () => readOnly;

  class ReadOnlyWriteError extends Error {
    constructor(what) {
      super(
        "Refused to write " +
          what +
          " while an archive is open. The array in memory is the archive " +
          "file's, not this browser's history."
      );
      this.name = "ReadOnlyWriteError";
    }
  }

  /* The one write of the match array. `then` runs only on success, so a caller
   * cannot paint "saved" over a refusal. */
  function writeMatches(matches, then) {
    if (readOnly) throw new ReadOnlyWriteError("matches");
    chrome.storage.local.set({ matches }, () => {
      void chrome.runtime.lastError;
      if (then) then();
    });
  }

  /** Arbitrary keys - logs and card lists on import, nothing else. */
  function writeKeys(entries, then) {
    if (readOnly) throw new ReadOnlyWriteError("stored records");
    chrome.storage.local.set(entries, () => {
      void chrome.runtime.lastError;
      if (then) then();
    });
  }

  function removeKeys(keys, then) {
    if (readOnly) throw new ReadOnlyWriteError("stored records");
    chrome.storage.local.remove(keys, () => {
      void chrome.runtime.lastError;
      if (then) then();
    });
  }

  // ---- settings ---------------------------------------------------------

  /* The recorder reads visualReplay* out of this same object at match start,
   * and the service worker reads the retention count at every gc. shareEndpoint
   * is a public URL, not a secret - see share/config.js. It is a setting with
   * no Settings field on purpose: a self-hoster can point the extension at
   * their own instance by writing it to storage, and everyone else is spared a
   * box they would never touch. There is deliberately no TTL setting - expiry
   * is a bucket-wide lifecycle rule, not a property of a share. */
  const defaultSettings = {
    autoBackup: false,
    lastBackup: 0,
    bannerDismissed: 0,
    visualReplayEnabled: true,
    visualReplayKeepMatches: 25,
    visualReplayMaxMatchMb: 512,
    // Guarded because this file is also require()d by the test suite, where
    // there is no share/config.js and no window. In the page the load order is
    // asserted by test/storage-writes.test.js, so the fallback never applies.
    shareEndpoint: root.RAShareConfig ? root.RAShareConfig.DEFAULT_SHARE_ENDPOINT : "",
    // Series detection. The window is measured from one match ending to the
    // next starting; the format is what a detected series is called before it
    // finishes, and changing it on one series does not change this default.
    seriesDetect: true,
    seriesWindowMinutes: 45,
    seriesFormatDefault: "bo3",
    // Which view was open, so a reload comes back to it.
    view: "overview",
    // Suggestion keys the user has said "not a series" to. Persisted, or the
    // same pair is proposed again on every reload.
    seriesDismissed: [],
  };

  const getSettings = (cb) =>
    chrome.storage.local.get({ settings: defaultSettings }, (d) =>
      cb(Object.assign({}, defaultSettings, d.settings || {}))
    );

  /* Settings are not match data, so they are writable in archive mode: which
   * view you are looking at and whether the backup nag is dismissed are
   * properties of this browser, not of the file being viewed. */
  const setSettings = (s, cb) =>
    chrome.storage.local.set({ settings: s }, () => {
      void chrome.runtime.lastError;
      if (cb) cb();
    });

  /** Read, patch, write. Avoids clobbering keys a caller did not mean to touch. */
  function patchSettings(patch, cb) {
    getSettings((s) => setSettings(Object.assign({}, s, patch), cb));
  }

  // ---- shares -----------------------------------------------------------

  /* NEVER CACHED, and it must stay that way.
   *
   * The share flow reads this at the moment the button is pressed, not when
   * the panel was opened, and the whole reuse decision rests on that: a panel
   * can sit open for minutes while a share of the same match lands from the
   * replay modal behind it. A cached list would miss it and upload a second
   * 3.5 MB copy of the same replay - which cannot be deleted, and is served
   * for seven days. That is the one-way door this subsystem exists to avoid.
   *
   * A failed read is an empty list: there is nothing visible to reuse, and an
   * upload is the right answer to that. */
  function readShares() {
    return new Promise((resolve) =>
      chrome.storage.local.get({ shares: [] }, (data) => {
        void chrome.runtime.lastError;
        resolve((data && data.shares) || []);
      })
    );
  }

  function writeShares(shares, then) {
    if (readOnly) throw new ReadOnlyWriteError("share records");
    chrome.storage.local.set({ shares }, () => {
      void chrome.runtime.lastError;
      if (then) then();
    });
  }

  root.RATrackerStorage = {
    setReadOnly,
    isReadOnly,
    ReadOnlyWriteError,
    writeMatches,
    writeKeys,
    removeKeys,
    defaultSettings,
    getSettings,
    setSettings,
    patchSettings,
    readShares,
    writeShares,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerStorage;
}
