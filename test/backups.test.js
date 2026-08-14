/* When the dashboard asks for a backup, and what it says when it does.
 *
 * Every match this extension has recorded lives in one browser profile. The
 * banner is the only warning anyone gets before removing the extension takes
 * the lot - so it has to appear when there is something to lose, and it has to
 * stop appearing once there is not, or it becomes furniture and stops being
 * read.
 *
 * Both halves of that are decidable from the settings, the clock and a count,
 * which is why they are a function rather than five conditions inside a paint.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const B = require("../dashboard/backups.js");

const DAY = B.DAY_MS;
const NOW = Date.parse("2026-08-14T12:00:00Z");

const settings = (over) =>
  Object.assign({ autoBackup: false, lastBackup: 0, bannerDismissed: 0 }, over);

const state = (over, ctx) =>
  B.bannerState(settings(over), Object.assign({ now: NOW, count: 10, granted: false, readOnly: false }, ctx));

// ---- when the daily backup runs ----------------------------------------

test("a backup is due once a day has passed, and not before", () => {
  assert.equal(B.isBackupDue(settings({ lastBackup: NOW - DAY - 1 }), NOW), true);
  assert.equal(B.isBackupDue(settings({ lastBackup: NOW - DAY }), NOW), false);
  assert.equal(B.isBackupDue(settings({ lastBackup: NOW }), NOW), false);
});

test("never having backed up is overdue, not up to date", () => {
  // lastBackup defaults to 0, and `0 - now > DAY` has to come out true or the
  // first automatic backup never runs at all.
  assert.equal(B.isBackupDue(settings(), NOW), true);
  assert.equal(B.isBackupDue({}, NOW), true);
});

// ---- when the banner shows ---------------------------------------------

test("a history worth losing and no backup gets the banner", () => {
  const s = state();
  assert.equal(s.show, true);
  assert.match(s.text, /You have 10 matches stored only inside this extension/);
  assert.match(s.text, /wipes them/);
});

test("almost no history does not get nagged", () => {
  // Asking someone to protect two matches is how a warning becomes furniture.
  assert.equal(state({}, { count: B.MIN_MATCHES - 1 }).show, false);
  assert.equal(state({}, { count: B.MIN_MATCHES }).show, true);
});

test("a recent backup silences it, and a stale one brings it back", () => {
  assert.equal(state({ lastBackup: NOW - DAY }).show, false);
  assert.equal(state({ lastBackup: NOW - B.STALE_DAYS * DAY }).show, false);
  const stale = state({ lastBackup: NOW - (B.STALE_DAYS + 1) * DAY });
  assert.equal(stale.show, true);
  assert.match(stale.text, /^Your last backup was /);
  assert.match(stale.text, /Matches since then exist only inside this extension/);
});

test("dismissing it buys a week, not silence", () => {
  assert.equal(state({ bannerDismissed: NOW - 3 * DAY }).show, false);
  assert.equal(state({ bannerDismissed: NOW - (B.DISMISSED_DAYS + 1) * DAY }).show, true);
});

test("auto-backup silences it only when it can actually write", () => {
  /* The switch can be on while the downloads permission has been revoked in
   * chrome://extensions, which is a backup that has never run and never will. */
  assert.equal(state({ autoBackup: true }, { granted: true }).show, false);
  assert.equal(state({ autoBackup: true }, { granted: false }).show, true);
});

test("an archive file being open is not this browser's history to nag about", () => {
  assert.equal(state({}, { readOnly: true }).show, false);
});

test("a hidden banner carries no text to leave behind", () => {
  // The paint only writes the text when it shows, so a stale sentence must not
  // be what a later show puts back on screen.
  assert.equal(state({}, { count: 0 }).text, "");
});

// ---- the line under the switch -----------------------------------------

test("the backup state names the date, and says nothing before the first one", () => {
  assert.equal(B.backupStateText(settings()), "");
  assert.equal(
    B.backupStateText(settings({ lastBackup: NOW })),
    "last backup " + new Date(NOW).toLocaleDateString()
  );
});
