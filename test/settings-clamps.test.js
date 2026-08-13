/* The three Settings fields that are not just stored as typed.
 *
 * Each of these guards something that runs somewhere else and cannot check
 * again: the retention count is read by the service worker's gc, the byte
 * ceiling by the capture policy in the content script, the endpoint by the
 * share upload. A NaN reaching any of them is not a bad setting, it is a
 * feature that stops working with nothing in the console - and in the gc's
 * case, recordings deleted that the user meant to keep.
 *
 * A number input's min/max constrain its spinner and nothing else. Anything at
 * all can be typed or pasted into one, which is why these clamp rather than
 * trust the markup.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const C = require("../dashboard/settings-clamps.js");

const KEEP_DEFAULT = 25;
const CEILING_DEFAULT = 512;
const keep = (v) => C.clampKeep(v, KEEP_DEFAULT);
const ceiling = (v) => C.clampCeiling(v, CEILING_DEFAULT);

// ---- clampKeep ---------------------------------------------------------

test("a retention count in range is kept as typed", () => {
  assert.equal(keep(25), 25);
  assert.equal(keep("40"), 40, "a DOM input hands over a string");
  assert.equal(keep(C.KEEP_MIN), C.KEEP_MIN);
  assert.equal(keep(C.KEEP_MAX), C.KEEP_MAX);
});

test("a retention count outside the bounds is clamped, not rejected", () => {
  assert.equal(keep(0), C.KEEP_MIN, "keeping none would delete every recording");
  assert.equal(keep(-10), C.KEEP_MIN);
  assert.equal(keep(9999), C.KEEP_MAX);
});

test("a fractional retention count rounds to a whole number of matches", () => {
  assert.equal(keep(3.4), 3);
  assert.equal(keep(3.5), 4);
  assert.equal(keep(0.4), C.KEEP_MIN, "rounding to 0 must still clamp up");
});

test("an unnumeric retention count falls back to the default", () => {
  for (const bad of ["abc", undefined, NaN, Infinity, -Infinity, {}]) {
    assert.equal(keep(bad), KEEP_DEFAULT, String(bad));
  }
});

/* PINNED, NOT ENDORSED - clearing the retention field stores 1, not the default.
 *
 * Number("") is 0, not NaN, so a blank field never reaches the fallback: it is
 * a finite 0 and gets clamped up to KEEP_MIN. Clearing the box and tabbing out
 * therefore sets retention to "keep the newest 1", and the service worker's
 * next gc deletes the other 24 recordings. Nothing asks first and nothing says
 * so afterwards; the field just shows 1.
 *
 * clampCeiling next door treats a blank as its own meaning ("no limit") before
 * touching Number, which is why it does not have this. There is no equivalent
 * meaning for a blank retention count - so this is asserted as it stands and
 * reported rather than changed under a refactor. null and [] are the same
 * coercion arriving from storage rather than from the field. */
test("a blank retention field clamps to the minimum rather than the default", () => {
  for (const blank of ["", "   ", null, []]) {
    assert.equal(keep(blank), C.KEEP_MIN, JSON.stringify(blank));
  }
});

test("the retention fallback is the caller's, not one baked in here", () => {
  assert.equal(C.clampKeep("abc", 7), 7);
});

// ---- clampCeiling ------------------------------------------------------

test("a byte ceiling in range is kept as typed", () => {
  assert.equal(ceiling(512), 512);
  assert.equal(ceiling("256"), 256);
  assert.equal(ceiling(C.CEILING_MIN_MB), C.CEILING_MIN_MB);
  assert.equal(ceiling(C.CEILING_MAX_MB), C.CEILING_MAX_MB);
});

test("a blank ceiling is the no-limit affordance and stores as 0", () => {
  // 0 is what the capture policy reads as uncapped. It is a real setting, not
  // a missing one, which is why it is not sent to the fallback.
  assert.equal(ceiling(""), 0);
  assert.equal(ceiling(null), 0);
  assert.equal(ceiling(undefined), 0);
});

test("zero and below also mean no limit", () => {
  assert.equal(ceiling(0), 0);
  assert.equal(ceiling(-1), 0);
  assert.equal(ceiling("-400"), 0);
});

test("a ceiling above zero is clamped into range", () => {
  // Never below CEILING_MIN_MB: a runaway guard set to 1 MB would shape normal
  // capture instead of catching a runaway, and every replay would truncate.
  assert.equal(ceiling(1), C.CEILING_MIN_MB);
  assert.equal(ceiling(15), C.CEILING_MIN_MB);
  assert.equal(ceiling(99999), C.CEILING_MAX_MB);
});

test("a fractional ceiling rounds before it is clamped", () => {
  assert.equal(ceiling(20.6), 21);
  // Rounds to 0, which is "no limit" rather than the minimum: 0.4 MB was never
  // a usable budget, and refusing to record at all is the worse answer.
  assert.equal(ceiling(0.4), 0);
});

test("an unreadable ceiling falls back to the default", () => {
  for (const bad of ["abc", NaN, Infinity, {}]) {
    assert.equal(ceiling(bad), CEILING_DEFAULT, String(bad));
  }
});

test("the ceiling fallback is the caller's, not one baked in here", () => {
  assert.equal(C.clampCeiling("abc", 64), 64);
});

// ---- cleanEndpoint -----------------------------------------------------

const DEFAULT_ENDPOINT = "https://share.example.test";
const clean = (v) => C.cleanEndpoint(v, DEFAULT_ENDPOINT);

test("an endpoint is stored with its trailing slashes stripped", () => {
  // Every request appends its own path, so a stored trailing slash produces
  // `//u` and `//b/<id>`, which the Worker's router does not match.
  assert.equal(clean("https://share.example.test/"), "https://share.example.test");
  assert.equal(clean("https://share.example.test///"), "https://share.example.test");
  assert.equal(clean("https://share.example.test"), "https://share.example.test");
});

test("surrounding whitespace is trimmed, because a pasted URL brings it", () => {
  assert.equal(clean("  https://share.example.test/  "), "https://share.example.test");
});

test("blanking the field restores the default rather than clearing it", () => {
  // There is no other way back. An empty endpoint would leave sharing with
  // nowhere to go and no message saying so.
  for (const blank of ["", "   ", null, undefined]) {
    assert.equal(clean(blank), DEFAULT_ENDPOINT, JSON.stringify(blank));
  }
});

test("cleaning does not judge the URL, only its shape", () => {
  /* Whether an endpoint is allowed at all is `RAShareUI.endpointProblem`, and
   * it runs at the moment of sharing against whatever was stored. Rejecting
   * here as well would mean two answers to one question, and the stored value
   * would silently differ from the one the user typed. */
  assert.equal(clean("not a url"), "not a url");
  assert.equal(clean("http://localhost:8787/"), "http://localhost:8787");
});

// ---- the module itself -------------------------------------------------

test("the module loads under node with no window and exports its surface", () => {
  assert.equal(typeof window, "undefined", "this suite runs with no DOM shim");
  assert.equal(C, globalThis.RATrackerSettingsClamps, "the require export is the global legacy.js reads");
  for (const name of ["clampKeep", "clampCeiling", "cleanEndpoint"]) {
    assert.equal(typeof C[name], "function", `${name} must be exported`);
  }
  // The spinners' bounds are set from these, so the markup and the clamp
  // cannot drift.
  for (const name of ["KEEP_MIN", "KEEP_MAX", "CEILING_MIN_MB", "CEILING_MAX_MB"]) {
    assert.equal(typeof C[name], "number", `${name} must be exported`);
  }
});
