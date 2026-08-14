/* Rift Atlas Stats Tracker - saying something, from a classic script
 *
 * The toast and the dialog are ES modules, published on window by main.js
 * because a classic script cannot import one. Every view drained out of
 * legacy.js needs both, and each was carrying its own copy of the two lines
 * that reach them - including the fallback, which is the part worth having in
 * one place: main.js is deferred, so a classic script that called the toast at
 * evaluation time would find nothing there. Nothing does, today; the fallback
 * is what keeps that true of a file loaded on its own or under a test.
 *
 * Deliberately not a wrapper around the components themselves - it is the
 * lookup that is shared, not the behaviour, so `ask` hands back the dialog's
 * own promise untouched.
 */
(function (root) {
  "use strict";

  /** A toast, or the console when the module half has not loaded. */
  const say = (message, kind) => {
    const toast = root.RATrackerToast;
    if (toast) toast(message, { kind });
    else console.info("[RA-Tracker]", message);
  };

  /* Looked up at call time, never bound: main.js sets these after every classic
   * script has run. Both are only ever reached from an event handler, which
   * cannot fire before the page is interactive. */
  const dialog = () => root.RATrackerDialog;
  const ask = (opts) => dialog().confirm(opts);

  root.RATrackerNotify = { say, ask, dialog };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerNotify;
}
