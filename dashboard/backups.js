/* Rift Atlas Stats Tracker - backups, and the nag that asks for one
 *
 * Every match this extension has ever recorded lives in one browser profile's
 * extension storage. Removing the extension, or loading it from a different
 * folder, takes the lot - with no warning from Chrome and nothing to restore
 * from. That is the whole reason this file exists: a daily copy in Downloads,
 * and a banner for the people who have not turned it on.
 *
 * The banner is deliberately not a permanent fixture. It appears once there is
 * something worth losing, it goes away when a backup exists, and dismissing it
 * buys a week - so it stays a warning rather than becoming furniture nobody
 * reads. That decision is `bannerState`, which is decidable from the settings,
 * the clock and a count, and is therefore tested.
 *
 * Writing the file needs the `downloads` permission, which is OPTIONAL and
 * asked for at the moment it is needed. Declining it is not an error: the
 * fallback is the same bundle saved through the browser's own download prompt,
 * which is what the Export button does.
 */
(function (root) {
  "use strict";

  const { say } = root.RATrackerNotify || require("./notify.js");
  const STORE = () => root.RATrackerStorage;
  const DATA_IO = () => root.RATrackerDataIo;

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

  const DAY_MS = 86400000;
  // How long a backup stays fresh before the banner comes back, and how long
  // dismissing it lasts. Two weeks is roughly a season's worth of play; a week
  // of silence is long enough that the reminder is not the same reminder.
  const STALE_DAYS = 14;
  const DISMISSED_DAYS = 7;
  // Below this the nag would be asking someone to protect almost nothing.
  const MIN_MATCHES = 3;

  let matches = () => [];
  let readOnly = () => false;

  // ---- the decisions -----------------------------------------------------

  /** Whether the daily automatic backup is overdue. */
  const isBackupDue = (settings, now) => now - (settings.lastBackup || 0) > DAY_MS;

  /**
   * Whether to nag, and what the nag says.
   *
   * `granted` is whether the downloads permission is held: auto-backup that is
   * switched on but cannot write is not a backup, so the banner stays.
   */
  function bannerState(settings, ctx) {
    const now = ctx.now;
    const count = ctx.count;
    const never = !settings.lastBackup;
    const stale = !!settings.lastBackup && now - settings.lastBackup > STALE_DAYS * DAY_MS;
    const dismissedRecently = now - (settings.bannerDismissed || 0) < DISMISSED_DAYS * DAY_MS;
    const show =
      !ctx.readOnly &&
      count >= MIN_MATCHES &&
      (never || stale) &&
      !(settings.autoBackup && ctx.granted) &&
      !dismissedRecently;
    if (!show) return { show: false, text: "" };
    return {
      show: true,
      text: never
        ? `You have ${count} matches stored only inside this extension. Removing it — or loading it from a different folder — wipes them. Save a backup.`
        : `Your last backup was ${new Date(settings.lastBackup).toLocaleDateString()}. Matches since then exist only inside this extension.`,
    };
  }

  /** The line under the auto-backup switch. Blank until one has been written. */
  const backupStateText = (settings) =>
    settings.lastBackup ? "last backup " + new Date(settings.lastBackup).toLocaleDateString() : "";

  // ---- writing one -------------------------------------------------------

  const hideBanner = () => {
    const el = $("#backupBanner");
    if (el) el.hidden = true;
  };

  const showBackupState = (s) => setText("#backupState", backupStateText(s));

  function writeBackup(cb) {
    if (!matches().length) return cb && cb(new Error("nothing to back up"));
    // Backups carry matches + logs (small); the per-match card codes are
    // excluded to keep the daily file sane - Archive & clear includes them.
    DATA_IO().buildBundle(false, (bundle) => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" })
      );
      try {
        chrome.downloads.download(
          {
            url,
            filename: `riftatlas-backups/matches-${DATA_IO().stamp()}.json`,
            conflictAction: "overwrite",
            saveAs: false,
          },
          () => {
            setTimeout(() => URL.revokeObjectURL(url), 30000);
            STORE().getSettings((s) => {
              s.lastBackup = Date.now();
              STORE().setSettings(s, () => {
                showBackupState(s);
                cb && cb(null);
              });
            });
          }
        );
      } catch (err) {
        URL.revokeObjectURL(url);
        cb && cb(err);
      }
    });
  }

  /* The fallback when the Downloads folder is not ours to write to: the same
   * bundle, saved the way the Export button saves it. Declining the permission
   * must still leave a way to get the data out. */
  const downloadBundle = () =>
    DATA_IO().buildBundle(false, (b) =>
      DATA_IO().download(
        `riftatlas-matches-${DATA_IO().stamp()}.json`,
        JSON.stringify(b, null, 2),
        "application/json"
      )
    );

  const requestPermission = (cb) => chrome.permissions.request({ permissions: ["downloads"] }, cb);
  const hasPermission = (cb) => chrome.permissions.contains({ permissions: ["downloads"] }, cb);

  /** Repaint the switch, the date under it and the banner, from storage. */
  function refresh() {
    STORE().getSettings((s) => {
      hasPermission((granted) => {
        const box = $("#autoBackup");
        if (box) box.checked = !!(s.autoBackup && granted);
        showBackupState(s);
        if (s.autoBackup && granted && isBackupDue(s, Date.now())) writeBackup();
        paintBanner(s, granted);
      });
    });
  }

  function paintBanner(settings, granted) {
    const banner = $("#backupBanner");
    if (!banner) return;
    const state = bannerState(settings, {
      now: Date.now(),
      count: matches().length,
      granted,
      readOnly: readOnly(),
    });
    banner.hidden = !state.show;
    if (state.show) setText("#backupBannerText", state.text);
  }

  // ---- the controls ------------------------------------------------------

  function mount(deps) {
    matches = deps.matches;
    readOnly = deps.readOnly;

    on("#autoBackup", "change", (e) => {
      if (!e.target.checked) {
        STORE().getSettings((s) => {
          s.autoBackup = false;
          STORE().setSettings(s, refresh);
        });
        return;
      }
      requestPermission((granted) => {
        if (!granted) {
          e.target.checked = false;
          say("Downloads permission is needed to save backup files automatically.", "error");
          return;
        }
        STORE().getSettings((s) => {
          s.autoBackup = true;
          STORE().setSettings(s, () => writeBackup(() => refresh()));
        });
      });
    });

    on("#bannerBackup", "click", () => {
      hasPermission((granted) => {
        const go = () =>
          writeBackup((err) => {
            if (err) downloadBundle();
            hideBanner();
          });
        if (granted) return go();
        requestPermission((ok) => {
          if (ok) return go();
          downloadBundle();
          hideBanner();
        });
      });
    });

    on("#bannerDismiss", "click", () => {
      STORE().getSettings((s) => {
        s.bannerDismissed = Date.now();
        STORE().setSettings(s, hideBanner);
      });
    });
  }

  root.RATrackerBackups = {
    DAY_MS,
    STALE_DAYS,
    DISMISSED_DAYS,
    MIN_MATCHES,
    isBackupDue,
    bannerState,
    backupStateText,
    refresh,
    mount,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerBackups;
}
