/* dialog.js is mostly DOM - a <dialog>, a focus restore, a promise - and the
 * repo's rule is that browser code stays small and obviously correct rather
 * than unit tested. Three things inside it are not DOM, though, and each one is
 * a rule the next caller would otherwise re-derive by hand:
 *
 *   - which buttons a caller actually gets, and in what order, given that the
 *     destructive one must be last however it was passed in;
 *   - which button starts focused, given that a confirm whose affirmative
 *     action is destructive must not open with Delete under the Return key;
 *   - what a textPrompt validator's return value means, given that the natural
 *     way to write one has no explicit return on the valid path.
 *
 * They live in dashboard/dialog-support.js precisely so they can be pinned
 * here. The rest of the file is verified by using it.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const D = require("../dashboard/dialog-support.js");

const labels = (actions) => actions.map((a) => a.label);
const kinds = (actions) => actions.map((a) => a.kind);

// ---- normalizeActions --------------------------------------------------

test("keeps the caller's order when nothing is dangerous", () => {
  const out = D.normalizeActions([
    { label: "Cancel", value: false, kind: "quiet" },
    { label: "Save", value: true, kind: "primary" },
  ]);
  assert.deepEqual(labels(out), ["Cancel", "Save"]);
  assert.deepEqual(kinds(out), ["quiet", "primary"]);
});

test("moves a danger action last however it was passed in", () => {
  const out = D.normalizeActions([
    { label: "Delete", value: "del", kind: "danger" },
    { label: "Cancel", value: false, kind: "quiet" },
    { label: "Archive first", value: "arch", kind: "primary" },
  ]);
  assert.deepEqual(labels(out), ["Cancel", "Archive first", "Delete"]);
});

test("keeps two danger actions in the order they were given", () => {
  const out = D.normalizeActions([
    { label: "Delete match", kind: "danger" },
    { label: "Cancel", kind: "quiet" },
    { label: "Delete series", kind: "danger" },
  ]);
  assert.deepEqual(labels(out), ["Cancel", "Delete match", "Delete series"]);
});

test("an action with no value resolves as its own label, never undefined", () => {
  // undefined is what a dismissal resolves to, so an action resolving undefined
  // would be indistinguishable from the user pressing Escape.
  const out = D.normalizeActions([{ label: "Keep both" }]);
  assert.equal(out[0].value, "Keep both");
});

test("a falsy value the caller meant is preserved", () => {
  const out = D.normalizeActions([{ label: "No", value: false }, { label: "Zero", value: 0 }]);
  assert.equal(out[0].value, false);
  assert.equal(out[1].value, 0);
});

test("an unknown or missing kind becomes quiet", () => {
  const out = D.normalizeActions([{ label: "A" }, { label: "B", kind: "scary" }]);
  assert.deepEqual(kinds(out), ["quiet", "quiet"]);
});

test("drops entries that are not an action", () => {
  const out = D.normalizeActions([null, "Save", { value: 1 }, { label: "   " }, { label: "Real" }]);
  assert.deepEqual(labels(out), ["Real"]);
});

test("labels are trimmed", () => {
  assert.equal(D.normalizeActions([{ label: "  Save  " }])[0].label, "Save");
});

test("an empty or missing actions list still yields one way out", () => {
  // A modal whose only exit is Escape looks broken to anyone using a mouse.
  for (const input of [undefined, null, [], [null]]) {
    assert.deepEqual(D.normalizeActions(input), [{ label: "OK", value: true, kind: "primary" }]);
  }
});

test("the default action is a copy, so one dialog cannot edit the next one's", () => {
  const first = D.normalizeActions([])[0];
  first.label = "Mutated";
  assert.equal(D.normalizeActions([])[0].label, "OK");
});

// ---- focusIndex --------------------------------------------------------

test("focus goes to the primary action", () => {
  const out = D.normalizeActions([
    { label: "Cancel", kind: "quiet" },
    { label: "Save", kind: "primary" },
  ]);
  assert.equal(D.focusIndex(out), 1);
});

test("a destructive confirm opens on Cancel, not on the destructive button", () => {
  const out = D.normalizeActions([
    { label: "Cancel", kind: "quiet" },
    { label: "Delete this match", kind: "danger" },
  ]);
  assert.equal(D.focusIndex(out), 0);
  assert.equal(out[D.focusIndex(out)].label, "Cancel");
});

test("with nothing but danger, the first one is focused", () => {
  const out = D.normalizeActions([{ label: "Delete", kind: "danger" }]);
  assert.equal(D.focusIndex(out), 0);
});

test("no actions means nothing to focus", () => {
  assert.equal(D.focusIndex([]), -1);
  assert.equal(D.focusIndex(undefined), -1);
});

// ---- runValidate -------------------------------------------------------

test("no validator means valid", () => {
  assert.equal(D.runValidate(undefined, "anything"), null);
  assert.equal(D.runValidate(null, ""), null);
});

test("a validator that returns nothing means valid", () => {
  // `if (bad) return "why";` with no return on the good path is how these get
  // written, and treating that undefined as an error would wedge the dialog.
  assert.equal(D.runValidate(() => {}, "Hollowmark Aggro"), null);
  assert.equal(D.runValidate(() => null, "x"), null);
  assert.equal(D.runValidate(() => false, "x"), null);
  assert.equal(D.runValidate(() => "", "x"), null);
  assert.equal(D.runValidate(() => "   ", "x"), null);
});

test("a returned string is the error, trimmed", () => {
  assert.equal(D.runValidate(() => "  Give this deck a name.  ", ""), "Give this deck a name.");
});

test("the validator sees the value it was given", () => {
  const seen = [];
  D.runValidate((v) => {
    seen.push(v);
  }, "  spaced  ");
  assert.deepEqual(seen, ["  spaced  "]);
});

test("a non-string rejection is stringified rather than dropped", () => {
  assert.equal(D.runValidate(() => 404, "x"), "404");
});

test("a validator that throws becomes its message, not an escaped exception", () => {
  // It runs inside a click handler; an exception there leaves the dialog open
  // with no error shown and the promise unsettled.
  assert.equal(
    D.runValidate(() => {
      throw new Error("that name is already taken");
    }, "x"),
    "that name is already taken"
  );
});

test("a validator that throws something without a message still says something", () => {
  const out = D.runValidate(() => {
    throw "nope"; // eslint-disable-line no-throw-literal
  }, "x");
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0);
});
