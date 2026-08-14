"use strict";

/* capture/page-ui.js is almost all DOM writing, which is not worth a test - the
 * toast either appears or it does not, and no assertion here would tell you
 * which. Two things in it are not DOM writing:
 *
 *   - the escaping. The toast interpolates the champion names into innerHTML,
 *     and those names are read off the game page's alt text: not attacker-
 *     controlled today, not ours either.
 *   - the "is this our own toast?" guard, which is what stops end detection
 *     reading the words "WIN detected" back off the toast and ending the match
 *     the toast is asking about. That one has teeth: without it a match that
 *     ends is immediately re-ended, and the endCount latch closes the record.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { el, text } = require("./fake-dom.js");

const pageUI = require("../capture/page-ui.js");

test("champion names are escaped before they reach innerHTML", () => {
  assert.equal(
    pageUI.escapeHtml(`<img src=x onerror="alert(1)">`),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"
  );
  assert.equal(pageUI.escapeHtml("Rek'Sai & Diana"), "Rek&#39;Sai &amp; Diana");
  assert.equal(pageUI.escapeHtml(null), "null", "a missing name is still a string");
});

test("our own toast is recognised, by element and by text node", () => {
  const toast = el({ sel: ["#ra-tracker-toast"] });
  const inside = el({ kids: [] });
  toast.children.push(inside);
  inside.parentElement = toast;

  assert.equal(pageUI.isOwnToast(inside), true);
  assert.equal(pageUI.isOwnToast(text("WIN detected", inside)), true, "text nodes resolve to their parent");

  const elsewhere = el({});
  assert.equal(pageUI.isOwnToast(elsewhere), false);
  assert.equal(pageUI.isOwnToast(text("VICTORY", elsewhere)), false);
  assert.equal(pageUI.isOwnToast(text("VICTORY", null)), false, "a detached text node is not ours");
});

test("an orphaned script is one that can no longer reach the extension", () => {
  const real = globalThis.chrome;
  try {
    globalThis.chrome = { runtime: { id: "abc" } };
    assert.equal(pageUI.isOrphaned(), false);
    globalThis.chrome = { runtime: {} };
    assert.equal(pageUI.isOrphaned(), true, "no id: the context was invalidated");
    globalThis.chrome = {};
    assert.equal(pageUI.isOrphaned(), true);
    globalThis.chrome = undefined;
    assert.equal(pageUI.isOrphaned(), true, "and a throw reading it counts too");
  } finally {
    globalThis.chrome = real;
  }
});
