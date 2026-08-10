/* share/clipboard.js - handing a link over, and saying that it happened.
 *
 * Four buttons across two surfaces use this: the row's share panel, the shares
 * list, the replay modal's "copy link to this moment", and the standalone
 * viewer's. The behaviour worth pinning down is what happens when the copy does
 * NOT work, because that is the path nobody exercises by hand.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { FLASH_MS, copyText, flash, copyToButton } = require("../share/clipboard.js");

/** A button with just enough of one to be flashed at. */
function fakeButton(label) {
  return { textContent: label, isConnected: true };
}

/** Timers that fire only when told to, so a test never waits 1.5 seconds. */
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout(fn) {
      pending.set(next, fn);
      return next++;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    runAll() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    get size() {
      return pending.size;
    }
  };
}

const wrote = (log) => ({ clipboard: { writeText: async (text) => log.push(text) } });
const refuses = { clipboard: { writeText: async () => { throw new Error("denied"); } } };

test("a copy that lands resolves true and passes the text through", async () => {
  const log = [];
  assert.strictEqual(await copyText("https://example/#1.a.b.5", { navigator: wrote(log) }), true);
  assert.deepStrictEqual(log, ["https://example/#1.a.b.5"]);
});

/* A refused permission, an insecure context and an engine without the API are
 * one outcome to every caller - the user did not get the text - and none of
 * them is an exception anyone here would catch. */
test("every way of not copying resolves false rather than rejecting", async () => {
  const noApi = [{}, { clipboard: {} }, { clipboard: { writeText: "not a function" } }];
  for (const navigator of noApi) {
    assert.strictEqual(await copyText("x", { navigator }), false, JSON.stringify(navigator));
  }
  assert.strictEqual(await copyText("x", { navigator: refuses }), false);
  assert.strictEqual(
    await copyText("x", { navigator: { clipboard: { writeText() { throw new Error("sync"); } } } }),
    false,
    "a writeText that throws synchronously is still just a failure"
  );
});

test("a flashed button says its piece and then goes back to its label", () => {
  const timers = fakeTimers();
  const button = fakeButton("Copy link");
  flash(button, "Copied", { timers });
  assert.strictEqual(button.textContent, "Copied");
  timers.runAll();
  assert.strictEqual(button.textContent, "Copy link");
});

/* Reading the label off the button at call time looks right and is not: the
 * second click reads "Copied" as the label and restores that, leaving a button
 * permanently claiming to be a past tense. */
test("a second flash restores the real label, not the first flash's message", () => {
  const timers = fakeTimers();
  const button = fakeButton("Copy link");
  flash(button, "Copied", { timers });
  flash(button, "Copied", { timers });
  assert.strictEqual(button.textContent, "Copied");
  timers.runAll();
  assert.strictEqual(button.textContent, "Copy link");
  assert.strictEqual(timers.size, 0, "the superseded timer must be cancelled, not left to fire");
});

test("a button that has gone by the time the message expires is left alone", () => {
  const timers = fakeTimers();
  const button = fakeButton("Copy link");
  flash(button, "Copied", { timers });
  button.isConnected = false;
  timers.runAll();
  assert.strictEqual(button.textContent, "Copied", "nothing is written back to a detached button");
});

test("the message stays up long enough to be read", () => {
  assert.ok(FLASH_MS >= 1000 && FLASH_MS <= 3000, "1.5s is the treatment the other buttons use");
});

test("a successful copy reports Copied and selects the field it was given", async () => {
  const timers = fakeTimers();
  const log = [];
  const calls = [];
  const field = { focus: () => calls.push("focus"), select: () => calls.push("select") };
  const button = fakeButton("Copy link");

  const ok = await copyToButton("LINK", button, { navigator: wrote(log), timers, field });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(log, ["LINK"]);
  assert.deepStrictEqual(calls, ["focus", "select"], "the field is selected before the attempt");
  assert.strictEqual(button.textContent, "Copied");
});

/* The field holds the same text and is already selected, so Ctrl+C is a real
 * instruction here - and a better one than a dialog, because the link stays on
 * screen. */
test("a refused copy with a field on screen points at the keyboard", async () => {
  const timers = fakeTimers();
  const asked = [];
  const button = fakeButton("Copy link");
  const field = { focus() {}, select() {} };

  const ok = await copyToButton("LINK", button, {
    navigator: refuses,
    timers,
    field,
    prompt: (...args) => asked.push(args)
  });
  assert.strictEqual(ok, false);
  assert.strictEqual(button.textContent, "Press Ctrl+C");
  assert.deepStrictEqual(asked, [], "there is a field to copy from, so no dialog is needed");
});

/* The viewer and the replay modal have no field. Flashing an apology and doing
 * nothing else would leave the user with no way to get the link at all, so the
 * text goes somewhere still selectable from the keyboard. */
test("a refused copy with no field hands the text over anyway", async () => {
  const timers = fakeTimers();
  const asked = [];
  const button = fakeButton("Copy link to this moment");

  const ok = await copyToButton("LINK", button, {
    navigator: refuses,
    timers,
    prompt: (...args) => asked.push(args)
  });
  assert.strictEqual(ok, false);
  assert.strictEqual(button.textContent, "Copy failed");
  assert.strictEqual(asked.length, 1, "the link must end up somewhere the user can reach");
  assert.strictEqual(asked[0][1], "LINK");

  timers.runAll();
  assert.strictEqual(button.textContent, "Copy link to this moment");
});
