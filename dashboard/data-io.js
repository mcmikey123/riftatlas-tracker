/* Rift Atlas Stats Tracker - data in and out
 *
 * Export, import, archive, and the two ways to clear. Everything that moves the
 * whole history across the boundary of this browser.
 *
 * The FORMAT is bundle.js - the envelope, the CSV cell, the reader an import
 * comes back through - and is pure and tested. What is here is the half that
 * cannot be: the storage reads that assemble a bundle, the anchor click that
 * saves it, and the confirms in front of the two irreversible buttons.
 *
 * Three things in here are one-way doors, and each is written to be re-read
 * rather than trusted:
 *
 *   ARCHIVE & CLEAR wipes only what the file it just wrote actually holds. A
 *   match that finished while the dialog was open is not in that file, so
 *   clearing it would destroy the only copy.
 *   IMPORT merges by id and never drops a stored match the file does not carry.
 *   CLEAR ALL takes the share records with it: each holds a decryption key, and
 *   a "clean slate" that leaves every key this browser ever made behind is not
 *   one.
 *
 * The archive itself stays legacy.js's: one flag, one setter, kept in step with
 * the storage guard. This file asks for it and is handed a reader.
 */
(function (root) {
  "use strict";

  const { fmtDuration } = root.RATrackerFormat || require("./format.js");
  const BUNDLE = root.RATrackerBundle || require("./bundle.js");
  const ANALYSIS = root.RATrackerAnalysis || require("./analysis.js");
  const { say, ask } = root.RATrackerNotify || require("./notify.js");
  const { csvCell, parseBundle } = BUNDLE;
  // Reached at call time: storage.js is the dashboard's only writer, and
  // series.js decorates an export with the groupings a render would have shown.
  const STORE = () => root.RATrackerStorage;
  const SERIES = () => root.RATrackerSeries;

  const $ = (s) => document.querySelector(s);
  const on = (sel, type, fn) => {
    const el = $(sel);
    if (el) el.addEventListener(type, fn);
    return el;
  };
  const setText = (sel, s) => {
    const el = $(sel);
    if (el) el.textContent = s;
  };

  /* The match store, handed over whole by mount(): the array, the archive, the
   * log cache and the one write. Every one of these is legacy.js's state - this
   * file moves it in and out of files, it does not own it. */
  let store = null;
  let repaint = () => {};
  let reload = () => {};

  /* Mirrored so a bundle can be decorated without waiting on storage. Settings
   * were read once, at load, and never again - so toggling "Group best-of-three
   * games into a series" left this side holding the old value, and every
   * export, archive and daily backup written after that toggle described the
   * setting the user had just changed away from. */
  let seriesSettings = null;

  // ---- building a bundle -------------------------------------------------

  /* The match array with its series fields filled in. Reads the same settings
   * the dashboard renders with, so an export describes the series the user was
   * actually looking at.
   *
   * Automatic series are worked out at render time and never written, so an
   * export has to compute them too - otherwise a backup carries only the
   * groupings made by hand and every detected series is lost on import. The
   * manual ones are already on the records and pass through detect() untouched. */
  function withSeries(matches) {
    const series = SERIES();
    if (!series) return matches;
    const settings = seriesSettings || STORE().defaultSettings;
    return series.detect(matches, {
      enabled: settings.seriesDetect !== false,
      format: settings.seriesFormatDefault,
    }).matches;
  }

  /** Full portable bundle: matches with logs inline, optionally card codes. */
  function buildBundle(includeCards, cb) {
    const archive = store.archive();
    if (archive) {
      return cb(
        BUNDLE.bundleFrom({
          exportedAt: new Date().toISOString(),
          matches: archive.matches,
          deckCards: includeCards ? archive.deckCards || {} : {},
        })
      );
    }
    const all = store.matches();
    chrome.storage.local.get(null, (data) => {
      cb(
        BUNDLE.bundleFrom({
          exportedAt: new Date().toISOString(),
          matches: BUNDLE.inlineLogs(withSeries(all), data),
          deckCards: includeCards ? BUNDLE.deckCardsFrom(all, data) : {},
        })
      );
    });
  }

  // ---- what leaves --------------------------------------------------------

  function download(name, content, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  const stamp = () => new Date().toISOString().slice(0, 10);

  /* The columns, in order. The first block is the record as stored; the second
   * is what the game log adds up to, which is why an export is worth more than
   * the match array on its own. Every cell goes through csvCell, which quotes
   * per RFC 4180 and neutralises the values a spreadsheet would otherwise
   * evaluate - column 7 is an opponent's chosen display name. */
  const CSV_COLUMNS = ["startedAt","endedAt","durationMs","mode","roomCode","myName","opponentName","myLegend","myChampion","opponentLegend","opponentChampion","myScore","opponentScore","turns","result","resultSource","endReason","deckName","deckSource","seriesId","seriesGame","seriesFormat","seriesSource","notes"];
  const CSV_DERIVED = ["duration","verdict","myCommits","oppCommits","myConquers","oppConquers","myTrashed","oppTrashed","logLines"];

  /** The whole CSV, header row included. Decidable from the bundle alone. */
  function csvText(bundle) {
    return [CSV_COLUMNS.concat(CSV_DERIVED).join(",")]
      .concat(
        (bundle.matches || []).map((m) => {
          const a = ANALYSIS.analyse(m);
          const vals = CSV_COLUMNS.map((c) => csvCell(m[c]));
          vals.push(
            csvCell(fmtDuration(m.durationMs)), csvCell(a.verdict),
            csvCell(a.self.commit), csvCell(a.opponent.commit),
            csvCell(a.self.conquer), csvCell(a.opponent.conquer),
            csvCell(a.self.trash), csvCell(a.opponent.trash), csvCell(a.lines)
          );
          return vals.join(",");
        })
      )
      .join("\n");
  }

  // ---- what comes back ----------------------------------------------------

  /**
   * The storage writes an imported bundle turns into, and the logs to cache.
   *
   * A MERGE, not a replace: the stored matches are keyed by id and the file's
   * records are set over them, so a match the file has never heard of survives
   * the import. Logs are lifted back out into their own keys, which is where
   * everything reads them from - `all` holds lean records.
   */
  function bundleWrites(bundle, storedMatches) {
    const byId = new Map((storedMatches || []).filter((m) => m && m.id).map((m) => [m.id, m]));
    const writes = {};
    const logs = [];
    for (const m of bundle.matches) {
      if (!m || !m.id) continue;
      const lean = Object.assign({}, m);
      delete lean.log;
      byId.set(m.id, lean);
      if (Array.isArray(m.log) && m.log.length) {
        writes["log_" + m.id] = { id: m.id, log: m.log };
        logs.push([m.id, m.log]);
      }
    }
    for (const [id, codes] of Object.entries(bundle.deckCards || {})) {
      if (Array.isArray(codes) && codes.length) writes["deckcards_" + id] = { id, codes };
    }
    writes.matches = [...byId.values()];
    return { writes, logs };
  }

  function writeBundleToStorage(bundle, cb) {
    chrome.storage.local.get({ matches: [] }, (data) => {
      const { writes, logs } = bundleWrites(bundle, data.matches);
      for (const [id, log] of logs) store.cacheLog(id, log);
      STORE().writeKeys(writes, cb);
    });
  }

  // ---- what gets wiped ----------------------------------------------------

  /**
   * The keys a clear removes, given every key in storage.
   *
   * `archivedIds` limits it to the matches the archive file actually holds -
   * anything that finished while the confirm was open is not in that file, and
   * clearing it would destroy the only copy. Pass null for the clear-all path,
   * which takes every one.
   *
   * "shares" goes with the rest: each record holds a decryption key, and a wipe
   * that leaves every key a browser ever made behind is not the clean slate the
   * button offers.
   */
  function clearableKeys(keys, archivedIds) {
    return (keys || []).filter(
      (k) =>
        k === "shares" ||
        ((k.startsWith("deckcards_") || k.startsWith("log_")) &&
          (!archivedIds || archivedIds.has(k.slice(k.indexOf("_") + 1))))
    );
  }

  /** What a clear says afterwards, which turns on what it deliberately kept. */
  const clearedMessage = (kept) =>
    kept
      ? `Cleared. ${kept} match${kept === 1 ? "" : "es"} finished after the archive was written and ${kept === 1 ? "was" : "were"} kept.`
      : "Local data cleared. The archive file has everything.";

  const archiveConfirm = (count, sizeMb) => ({
    title: "Clear everything from the extension?",
    sub: `Archive downloaded — ${count} matches, ${sizeMb} MB`,
    body:
      "<p>Check it is in your Downloads folder first. This then wipes every match, game " +
      "log, card list, share record and replay from the extension.</p>" +
      "<p>You can open the file again any time with <b>View archive</b>, or merge it back " +
      "with <b>Import JSON</b>.</p>" +
      "<p>The archive does not carry share links. Any share already uploaded keeps being " +
      "served until it expires, but the record here is the only copy of the key that " +
      "opens it.</p>",
    confirmLabel: "Clear everything",
    danger: true,
  });

  const clearAllConfirm = () => ({
    title: "Delete everything in this browser?",
    body:
      "<p>Every match, game log, card list, share record and replay, with no copy taken.</p>" +
      "<p>Any share already uploaded keeps being served until it expires, but the key that " +
      "opens it is kept only here, so clearing this leaves it unopenable rather than " +
      "deleted.</p>" +
      "<p>If you might want the data later, use <b>Archive &amp; clear</b> instead, which " +
      "saves a copy first.</p>",
    confirmLabel: "Delete everything",
    danger: true,
  });

  // ---- the controls -------------------------------------------------------

  function mount(deps) {
    store = deps.store;
    repaint = deps.repaint;
    reload = deps.reload;
    // Read once here and re-read on every change, because several of these
    // settings are written by controls in other files.
    STORE().getSettings((s) => {
      seriesSettings = s;
    });
    chrome.storage.onChanged.addListener((changes) => {
      /* KNOWN STALENESS, moved here as it was rather than fixed. In legacy.js
       * this branch sat behind that listener's `if (archive) return`, which is
       * there to keep live writes from disturbing an archive VIEW - the mirror
       * was collateral. So: open an archive, toggle "Group best-of-three games
       * into a series", close the archive, export. The export is decorated from
       * the value the setting had before the toggle, and stays that way until
       * some later settings change arrives with no archive open.
       *
       * Kept identical because this wave moves code and changes none, and
       * because dropping the guard is a one-line change with a test behind it
       * rather than a side effect of a move. */
      if (store.readOnly()) return;
      if (changes.settings) STORE().getSettings((s) => { seriesSettings = s; });
    });

    on("#exportJson", "click", () => {
      buildBundle(true, (bundle) =>
        download(`riftatlas-matches-${stamp()}.json`, JSON.stringify(bundle, null, 2), "application/json")
      );
    });

    on("#exportCsv", "click", () => {
      buildBundle(false, (bundle) =>
        download(`riftatlas-matches-${stamp()}.csv`, csvText(bundle), "text/csv")
      );
    });

    on("#importJson", "click", () => {
      const f = $("#importFile");
      if (f) f.click();
    });
    on("#importFile", "change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      file.text().then((text) => {
        try {
          const bundle = parseBundle(text);
          writeBundleToStorage(bundle, () => {
            store.setArchive(null);
            store.clearLogs();
            reload();
            say(`Imported ${bundle.matches.length} matches into your live data.`, "success");
          });
        } catch (err) {
          say("Import failed: " + err.message, "error");
        }
      });
      e.target.value = "";
    });

    // Archive & clear: download everything, then wipe local storage.
    on("#archiveClear", "click", () => {
      if (store.readOnly()) return;
      if (!store.matches().length) return say("There are no matches to archive.");
      buildBundle(true, (bundle) => {
        const json = JSON.stringify(bundle, null, 2);
        const sizeMb = (new Blob([json]).size / 1048576).toFixed(1);
        const archivedIds = new Set(bundle.matches.map((m) => m.id));
        download(`riftatlas-archive-${stamp()}.json`, json, "application/json");
        /* The 800ms wait existed because a synchronous modal fired straight
         * after a programmatic click on a blob URL could suppress the download.
         * The dialog does not block, so the reason is gone with the modal that
         * needed it. */
        ask(archiveConfirm(bundle.matches.length, sizeMb)).then((ok) => {
          if (!ok) return;
          /* Anything that finished while the dialog was open is NOT in the file
           * that was just written, so clearing it would destroy the only copy.
           * The wipe is therefore limited to what the archive actually holds. */
          const stragglers = store.matches().filter((m) => !archivedIds.has(m.id));
          chrome.storage.local.get(null, (data) => {
            /* Same order as the single-match delete in legacy.js, and for the
             * same reason: the array is written FIRST, and the dependent keys
             * and recordings are torn down only once that write has landed.
             * This ran the other way round, with forgetAllVisual - which sends
             * to the service worker and repaints - sitting between the removal
             * of every log_<id> / deckcards_<id> and the write. A throw there
             * left `matches` holding every archived match with its log, its
             * cards and its share records already deleted. */
            const clearable = clearableKeys(Object.keys(data || {}), archivedIds);
            store.setMatches(stragglers);
            store.clearLogs();
            STORE().writeMatches(stragglers, () => {
              repaint();
              say(clearedMessage(stragglers.length), "success");
              STORE().removeKeys(clearable);
              root.RATrackerViewReplays.forgetAllVisual();
            });
          });
        });
      });
    });

    // View archive: render a file read-only without touching stored data.
    on("#viewArchive", "click", () => {
      if (store.archive()) {
        exitArchive();
        return;
      }
      const picker = $("#archiveFile");
      if (picker) picker.click();
    });
    on("#archiveFile", "change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      file.text().then((text) => {
        try {
          const bundle = parseBundle(text);
          store.setArchive({ name: file.name, matches: bundle.matches, deckCards: bundle.deckCards });
          store.clearLogs();
          setText("#viewArchive", "Exit archive");
          reload();
        } catch (err) {
          say("Could not read archive: " + err.message, "error");
        }
      });
      e.target.value = "";
    });
    on("#archiveExit", "click", exitArchive);

    on("#clearAll", "click", () => {
      if (store.readOnly()) return;
      ask(clearAllConfirm()).then((ok) => {
        if (!ok) return;
        store.setMatches([]);
        store.clearLogs();
        // Write-then-tear-down, as above. Nothing here can lose a match the way
        // the two paths above could - this one is clearing everything - but the
        // order is the one all three now follow.
        store.persist(store.matches(), () => {
          repaint();
          chrome.storage.local.get(null, (data) => {
            const keys = clearableKeys(Object.keys(data || {}), null);
            if (keys.length) STORE().removeKeys(keys);
          });
          root.RATrackerViewReplays.forgetAllVisual();
        });
      });
    });
  }

  /* Closing an archive is two controls - the banner's button and the menu entry
   * that opened it - and both have to put the menu entry's label back. */
  function exitArchive() {
    store.setArchive(null);
    store.clearLogs();
    setText("#viewArchive", "View archive");
    reload();
  }

  root.RATrackerDataIo = {
    buildBundle,
    download,
    stamp,
    csvText,
    CSV_COLUMNS,
    CSV_DERIVED,
    bundleWrites,
    clearableKeys,
    clearedMessage,
    archiveConfirm,
    clearAllConfirm,
    mount,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerDataIo;
}
