/* The shared formatters, and above all `esc`.
 *
 * Eight renderers - the replay viewer, the shell, dialogs, toasts, the popup,
 * the match and series tables and the legacy diagnostics - build their markup
 * by string concatenation, and `esc` is the only thing standing between an
 * opponent name typed by a stranger and the dashboard's own DOM. It had no
 * test at all. The rest of this file exists for a second reason: six of these
 * formatters are about to be deleted from legacy.js in favour of these ones,
 * so what "these ones" do has to be written down before the duplicates go.
 *
 * These are characterization tests. Where the behaviour below looks wrong it is
 * still pinned as-is, so a refactor is caught changing it either way.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const F = require("../dashboard/format.js");

// ---- esc ---------------------------------------------------------------

/* The five characters that matter, in the two positions the callers actually
 * interpolate into: element text (`>${esc(x)}<`) and a quoted attribute
 * (`data-deck="${esc(x)}"`). Miss the apostrophe and a single-quoted attribute
 * breaks out; miss the ampersand and every other escape can be smuggled past. */
test("escapes the five characters that can break out of markup", () => {
  assert.equal(F.esc("&"), "&amp;");
  assert.equal(F.esc("<"), "&lt;");
  assert.equal(F.esc(">"), "&gt;");
  assert.equal(F.esc('"'), "&quot;");
  assert.equal(F.esc("'"), "&#39;");
  assert.equal(F.esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("an injected tag or attribute survives as text, not as markup", () => {
  const escaped = F.esc('<img src=x onerror="alert(1)">');
  assert.ok(!escaped.includes("<"), "no raw angle bracket may reach the sink");
  assert.ok(!escaped.includes('"'), "no raw quote may close an attribute early");
  assert.equal(escaped, "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

test("every occurrence is escaped, not only the first", () => {
  // A `replace` without the /g flag passes this file's single-character tests
  // and still leaves the second bracket of `<b><i>` raw.
  assert.equal(F.esc("<b><i>"), "&lt;b&gt;&lt;i&gt;");
  assert.equal(F.esc("a&b&c"), "a&amp;b&amp;c");
});

test("ordinary text is returned untouched", () => {
  assert.equal(F.esc("brassline_02"), "brassline_02");
  assert.equal(F.esc("Hollowmark vs Morrow"), "Hollowmark vs Morrow");
  // Not an escaper's job, and mangling them would corrupt real opponent names.
  assert.equal(F.esc("héllo ✓ 日本"), "héllo ✓ 日本");
});

/* Callers pass numbers straight in - `esc(m.turns || "?")` in view-matches.js
 * and `esc(m.seriesGame == null ? "?" : m.seriesGame)` in view-series.js - so
 * the coercion is load-bearing, and 0 must render as "0" rather than being
 * swallowed as a falsy value the way null is. */
test("non-string values are stringified rather than dropped", () => {
  assert.equal(F.esc(42), "42");
  assert.equal(F.esc(0), "0", "a zero-turn match must show 0, not blank");
  assert.equal(F.esc(false), "false");
  assert.equal(F.esc(NaN), "NaN");
});

/* Renderers reach for fields that were never recorded - `esc(a.detail)` when a
 * match has no read, `esc(m.notes || "")` on an untouched match. Those must
 * render as an empty cell, and never as the strings "null"/"undefined" in the
 * page. */
test("null and undefined render as empty, not as the words null or undefined", () => {
  assert.equal(F.esc(null), "");
  assert.equal(F.esc(undefined), "");
});

// Worth pinning because it is the failure mode of a well-meant "escape it
// again to be safe" edit: the ampersands of the first pass get re-escaped and
// the user sees &amp;lt; in their own deck name.
test("escaping is not idempotent, so callers must escape exactly once", () => {
  assert.equal(F.esc(F.esc("&")), "&amp;amp;");
});

// ---- fmtClock ----------------------------------------------------------

test("the replay clock reads m:ss with a zero-padded seconds field", () => {
  assert.equal(F.fmtClock(0), "0:00");
  assert.equal(F.fmtClock(9000), "0:09");
  assert.equal(F.fmtClock(65000), "1:05");
  assert.equal(F.fmtClock(600000), "10:00");
});

/* The distinction the two clocks exist for: the replay transport never shows
 * an hours field, so an hour-long recording keeps counting minutes past 60
 * rather than resetting to 1:00:00. */
test("the replay clock counts past an hour in minutes and never shows hours", () => {
  assert.equal(F.fmtClock(3600000), "60:00");
  assert.equal(F.fmtClock(3661000), "61:01");
});

test("the replay clock rounds to the nearest second", () => {
  assert.equal(F.fmtClock(59499), "0:59");
  assert.equal(F.fmtClock(59500), "1:00");
});

// A negative position comes from a seek that ran off the front of the buffer.
// It has to read as the start, not as "-1:-1".
test("a negative position clamps to the start of the recording", () => {
  assert.equal(F.fmtClock(-5000), "0:00");
});

test("a non-numeric duration reads as a zeroed clock unless a fallback is given", () => {
  for (const bad of [NaN, Infinity, null, undefined, "60000"]) {
    assert.equal(F.fmtClock(bad), "0:00", `fmtClock(${String(bad)})`);
  }
  // The transport is always on screen, so a blank is a legitimate ask.
  assert.equal(F.fmtClock(NaN, ""), "");
  assert.equal(F.fmtClock(undefined, "--:--"), "--:--");
});

// ---- fmtDuration -------------------------------------------------------

test("a match length reads m:ss, and a summed one grows an hours field", () => {
  assert.equal(F.fmtDuration(65000), "1:05");
  assert.equal(F.fmtDuration(3600000), "1:00:00");
  assert.equal(F.fmtDuration(3661000), "1:01:01");
  assert.equal(F.fmtDuration(45296000), "12:34:56");
});

test("minutes and seconds are zero-padded once hours appear", () => {
  // 1:1:1 would sort and scan wrongly in a right-aligned numeric column.
  assert.equal(F.fmtDuration(3661000), "1:01:01");
  assert.equal(F.fmtDuration(3605000), "1:00:05");
});

test("a duration rounds to the nearest second", () => {
  assert.equal(F.fmtDuration(59499), "0:59");
  assert.equal(F.fmtDuration(59500), "1:00");
});

/* Unlike the replay clock, zero is not a duration here: a match with no
 * recorded length and one that lasted no time are the same unknown, and both
 * are better shown as a dash than as a measured 0:00. */
test("zero and negative durations read as unknown, not as 0:00", () => {
  assert.equal(F.fmtDuration(0), "–");
  assert.equal(F.fmtDuration(-1000), "–");
});

test("an unrecorded duration takes the caller's fallback when it supplies one", () => {
  assert.equal(F.fmtDuration(null), "–");
  assert.equal(F.fmtDuration(undefined), "–");
  assert.equal(F.fmtDuration(NaN), "–");
  assert.equal(F.fmtDuration(Infinity), "–", "an infinite length is not a length");
  assert.equal(F.fmtDuration("60000"), "–", "a numeric string is not a number here");
  assert.equal(F.fmtDuration(null, "—"), "—");
  assert.equal(F.fmtDuration(0, ""), "", "an empty fallback must survive, not fall back again");
});

/* The default fallback is an EN dash (U+2013), while DASH - what fmtBytes,
 * fmtCount, fmtMs, fmtDay, fmtTime and fmtScore all use - is an EM dash
 * (U+2014). Two different dashes sit in the same table row today. Pinned as
 * found; the callers that care already pass "—" explicitly. */
test("the duration fallback is an en dash, which is not the DASH the other formatters use", () => {
  assert.equal(F.fmtDuration(0), "–");
  assert.notEqual(F.fmtDuration(0), F.DASH);
  assert.equal(F.DASH, "—");
});

// ---- fmtBytes ----------------------------------------------------------

test("byte sizes step up through B, KB and MB with useful precision", () => {
  assert.equal(F.fmtBytes(0), "0 B");
  assert.equal(F.fmtBytes(512), "512 B");
  assert.equal(F.fmtBytes(1024), "1.0 KB");
  assert.equal(F.fmtBytes(1536), "1.5 KB");
  assert.equal(F.fmtBytes(1048576), "1.00 MB");
  assert.equal(F.fmtBytes(5242880), "5.00 MB");
});

test("byte counts are whole numbers, kilobytes one decimal and megabytes two", () => {
  assert.equal(F.fmtBytes(512.7), "513 B");
  assert.equal(F.fmtBytes(1075), "1.0 KB");
  assert.equal(F.fmtBytes(1572864), "1.50 MB");
});

/* Characterization, not endorsement: the unit is chosen from the raw byte
 * count but the number is rounded afterwards, so the last few bytes under each
 * boundary round up into a value that belongs in the next unit. */
test("sizes just under a unit boundary round into an out-of-range reading", () => {
  assert.equal(F.fmtBytes(1023.6), "1024 B");
  assert.equal(F.fmtBytes(1048575), "1024.0 KB");
});

test("a size that was never recorded reads as a dash, never as NaN or 0 B", () => {
  for (const bad of [null, undefined, NaN, Infinity, "1024", {}]) {
    assert.equal(F.fmtBytes(bad), F.DASH, `fmtBytes(${String(bad)})`);
  }
});

// ---- fmtCount / fmtMs --------------------------------------------------

/* Both exist to keep "not recorded" distinguishable from a measured zero: an
 * in-flight match, or one captured before a counter existed, has no value, and
 * a 0 in that column would read as a measurement someone took. */
test("a measured zero is shown as zero, and an absent value as a dash", () => {
  assert.equal(F.fmtCount(0), "0");
  assert.equal(F.fmtMs(0), "0 ms");
  assert.equal(F.fmtCount(null), F.DASH);
  assert.equal(F.fmtMs(null), F.DASH);
});

test("counts and timings render the number with their own unit", () => {
  assert.equal(F.fmtCount(1420), "1420");
  assert.equal(F.fmtMs(37), "37 ms");
  assert.equal(F.fmtMs(12.5), "12.5 ms", "sub-millisecond precision is not rounded away");
});

// The guard is !Number.isFinite, so an unfinished division or a string read
// straight out of storage lands on the dash rather than printing "NaN ms".
test("anything not a finite number is a dash rather than a printed NaN", () => {
  for (const bad of [undefined, NaN, Infinity, -Infinity, "5", []]) {
    assert.equal(F.fmtCount(bad), F.DASH, `fmtCount(${String(bad)})`);
    assert.equal(F.fmtMs(bad), F.DASH, `fmtMs(${String(bad)})`);
  }
});

// ---- champ -------------------------------------------------------------

test("the champion is the first field of a legend string, trimmed", () => {
  assert.equal(F.champ("Hollowmark, Dawnblade"), "Hollowmark");
  assert.equal(F.champ("Hollowmark,Dawnblade,Third"), "Hollowmark");
  assert.equal(F.champ("  Morrow  "), "Morrow");
  assert.equal(F.champ("Morrow"), "Morrow", "a legend field with no comma is already the champion");
});

/* The aggregate tables group by this value, so a missing legend needs a name
 * to be grouped under rather than an unlabelled row. */
test("a missing legend becomes Unknown rather than a blank grouping key", () => {
  for (const empty of [null, undefined, "", 0, false, NaN]) {
    assert.equal(F.champ(empty), "Unknown", `champ(${String(empty)})`);
  }
});

/* Characterization of a hole in the guarantee above: the fallback keys off the
 * argument being falsy, not off the result being empty, so a legend field that
 * starts with its separator still produces the blank grouping key the
 * "Unknown" fallback was written to prevent. */
test("a legend string beginning with a comma still yields a blank name", () => {
  assert.equal(F.champ(", Dawnblade"), "");
  assert.equal(F.champ("   "), "");
});

// ---- deckOf ------------------------------------------------------------

test("a deck name is trimmed, and an unnamed deck gets the shared bucket", () => {
  assert.equal(F.deckOf({ deckName: " Hollowmark Aggro " }), "Hollowmark Aggro");
  assert.equal(F.deckOf({ deckName: "" }), "Unlabelled");
  assert.equal(F.deckOf({ deckName: "   " }), "Unlabelled", "whitespace is not a deck name");
  assert.equal(F.deckOf({}), "Unlabelled");
});

// deckOf is mapped over match lists that can contain a hole, and a throw here
// takes the whole table down rather than one cell.
test("a missing match object is bucketed rather than thrown on", () => {
  assert.equal(F.deckOf(null), "Unlabelled");
  assert.equal(F.deckOf(undefined), "Unlabelled");
});

// ---- fmtDay ------------------------------------------------------------

const NOW = new Date(2026, 4, 20, 14, 30).getTime(); // 20 May 2026, local
const localIso = (y, m, d, h = 12) => new Date(y, m, d, h).toISOString();

test("the two most recent days are named rather than dated", () => {
  assert.equal(F.fmtDay(localIso(2026, 4, 20), NOW), "Today");
  assert.equal(F.fmtDay(localIso(2026, 4, 19), NOW), "Yesterday");
});

// The comparison is between calendar days, not between instants 24 hours
// apart - a match played at one minute past midnight is still Today at 14:30.
test("Today spans the whole calendar day, not the last 24 hours", () => {
  assert.equal(F.fmtDay(new Date(2026, 4, 20, 0, 0, 0).toISOString(), NOW), "Today");
  assert.equal(F.fmtDay(new Date(2026, 4, 20, 23, 59, 59).toISOString(), NOW), "Today");
});

/* The year is carried only when it differs from the current one - repeating
 * "2026" on every row is noise. Asserted by shape rather than by month name so
 * the test does not depend on the locale the runner happens to have. */
test("an older day drops the year when it is the current one and keeps it otherwise", () => {
  const thisYear = F.fmtDay(localIso(2026, 4, 2), NOW);
  const lastYear = F.fmtDay(localIso(2025, 4, 2), NOW);
  assert.match(thisYear, /^2 \S+$/, `expected "2 <month>", got ${thisYear}`);
  assert.equal(lastYear, thisYear + " 2025");
});

// Clock skew between the machine that recorded a match and the one reading it
// puts rows slightly in the future. They must date normally, not read as
// "Yesterday" or crash out.
test("a future day is dated like any other rather than named", () => {
  assert.match(F.fmtDay(localIso(2026, 4, 21), NOW), /^21 \S+$/, "tomorrow is not 'Yesterday'");
  assert.match(F.fmtDay(localIso(2027, 0, 3), NOW), /^3 \S+ 2027$/, "a future year is still carried");
});

test("an unparseable or missing date reads as a dash", () => {
  for (const bad of ["", null, undefined, "not a date", 0]) {
    assert.equal(F.fmtDay(bad, NOW), F.DASH, `fmtDay(${String(bad)})`);
  }
});

// `now` is injectable for the tests and for the shared-replay viewer, but the
// dashboard calls it with one argument on every row.
test("with no reference time supplied it compares against the present", () => {
  assert.equal(F.fmtDay(new Date().toISOString()), "Today");
});

// ---- fmtTime -----------------------------------------------------------

/* The wall clock a match started at, rendered in the viewer's locale. Pinned
 * against the local hour and minute rather than a literal string: the runner's
 * locale decides whether that hour appears as 20 or as 08 PM. */
test("a start time renders the local hour and minute of that instant", () => {
  const started = new Date(2026, 4, 9, 20, 14);
  const out = F.fmtTime(started.toISOString());
  assert.match(out, /\d{2}:14/, `expected the local minute in ${out}`);
  assert.ok(out.startsWith("20") || out.startsWith("08"), `expected the local hour in ${out}`);
});

test("a missing or unparseable start time reads as a dash", () => {
  for (const bad of ["", null, undefined, "whenever"]) {
    assert.equal(F.fmtTime(bad), F.DASH, `fmtTime(${String(bad)})`);
  }
});

// ---- fmtStamp ----------------------------------------------------------

/* The absolute date-and-time used by rows that outlive their match - a shared
 * link and a stored recording. Deliberately NOT fmtDay's relative wording:
 * "Yesterday" on a share that lapses in six days says nothing useful. */
test("a stamp carries both the date and the wall-clock time of that instant", () => {
  const at = new Date(2026, 4, 9, 20, 14);
  const out = F.fmtStamp(at.toISOString());
  assert.match(out, /\d{2}:14/, `expected the local minute in ${out}`);
  assert.ok(out.includes(at.toLocaleDateString()), `expected the local date in ${out}`);
});

test("a stamp uses the same wall clock as a start time, so two rows cannot disagree", () => {
  const at = new Date(2026, 4, 9, 20, 14);
  assert.ok(
    F.fmtStamp(at.toISOString()).endsWith(F.fmtTime(at.toISOString())),
    "fmtStamp's time half must be exactly what fmtTime renders"
  );
});

/* The shares list built this string by hand before, straight off a Date with
 * no guard, so a record with no createdAt rendered the literal "Invalid Date"
 * into the table. */
test("a missing or unparseable stamp reads as a dash, never as Invalid Date", () => {
  for (const bad of ["", null, undefined, "whenever"]) {
    assert.equal(F.fmtStamp(bad), F.DASH, `fmtStamp(${String(bad)})`);
  }
});

// ---- fmtScore ----------------------------------------------------------

test("a score reads as both sides separated by an en dash", () => {
  assert.equal(F.fmtScore({ myScore: 8, opponentScore: 5 }), "8–5");
  assert.equal(F.fmtScore({ myScore: 0, opponentScore: 0 }), "0–0");
});

/* One side scoring and the other not is a real state - a shutout - and has to
 * show the zero. Neither side ever being scored is the unknown, and that is
 * the only case that collapses to a dash. */
test("a side that never scored shows a zero, but a match never scored shows a dash", () => {
  assert.equal(F.fmtScore({ myScore: 8, opponentScore: null }), "8–0");
  assert.equal(F.fmtScore({ opponentScore: 3 }), "0–3");
  assert.equal(F.fmtScore({ myScore: null, opponentScore: null }), F.DASH);
  assert.equal(F.fmtScore({}), F.DASH);
});

test("a missing match object reads as a dash rather than throwing", () => {
  assert.equal(F.fmtScore(null), F.DASH);
  assert.equal(F.fmtScore(undefined), F.DASH);
});

// ---- fmtPercent --------------------------------------------------------

test("a rate renders as a whole-number percentage", () => {
  assert.equal(F.fmtPercent(0), "0%", "a 0% win rate is a result, not a missing one");
  assert.equal(F.fmtPercent(0.5), "50%");
  assert.equal(F.fmtPercent(1), "100%");
  assert.equal(F.fmtPercent(0.555), "56%", "rounded, not truncated");
  assert.equal(F.fmtPercent(0.334), "33%");
});

// A rate over no games at all is 0/0. It must not print "NaN%".
test("a rate that could not be computed reads as a dash", () => {
  for (const bad of [null, undefined, NaN, Infinity, "0.5"]) {
    assert.equal(F.fmtPercent(bad), "–", `fmtPercent(${String(bad)})`);
  }
});

// ---- the module itself -------------------------------------------------

/* The file is loaded by a plain <script> tag in dashboard.html, popup.html and
 * the replay viewer, and require()d here with no DOM shim. Both entry points
 * have to keep working: the IIFE binds to globalThis when there is no window,
 * and the CommonJS tail re-exports that same object. */
test("the module loads under node with no window and exports every formatter", () => {
  assert.equal(typeof window, "undefined", "this suite runs with no DOM shim");
  assert.equal(F, globalThis.RATrackerFormat, "the require export is the global the scripts use");
  for (const name of [
    "esc",
    "fmtClock",
    "fmtDuration",
    "fmtBytes",
    "fmtCount",
    "fmtMs",
    "fmtDay",
    "fmtTime",
    "fmtScore",
    "fmtPercent",
    "champ",
    "deckOf",
  ]) {
    assert.equal(typeof F[name], "function", `${name} must be exported`);
  }
  assert.equal(typeof F.DASH, "string");
});
