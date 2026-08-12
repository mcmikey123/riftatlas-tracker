/* Rift Atlas Stats Tracker - the decidable half of the dialog
 *
 * dialog.js is DOM: a <dialog>, a focus restore, a promise. None of that is
 * worth a unit test and the repo does not pretend otherwise. But three things
 * inside it are decisions rather than markup - which buttons a caller actually
 * gets, which one starts focused, and what a validator returning nothing means
 * - and each is a rule someone will otherwise re-derive at the next call site.
 *
 * They live here so they can be required from node without a DOM, exactly the
 * way series.js is: a classic script that hangs itself on `window` for the page
 * and off `module.exports` for the test suite. dialog.js reads them from
 * `window.RATrackerDialogSupport` rather than importing them, because a module
 * cannot import a classic script and there is no build step to make it one.
 *
 * Pure: no DOM, no chrome.*, no clock. Tested in test/dialog.test.js.
 */
(function (root) {
  "use strict";

  /* "primary" is the affirmative one, "quiet" is everything else, "danger" is
   * the one that destroys something. Nothing here is a colour - the kind names
   * a role and dashboard.css decides what that looks like. */
  const KINDS = ["primary", "quiet", "danger"];

  /* What a caller who supplied no usable action gets. A modal with an empty
   * footer is escapable but looks broken, and the one thing worse than an
   * unexpected button is no button at all. */
  const DEFAULT_ACTION = { label: "OK", value: true, kind: "primary" };

  /**
   * Clean a caller's `actions` into the array the footer renders.
   *
   * Two rules, both of which exist because the alternative is a bug you only
   * see in the one dialog nobody re-opened:
   *
   *   - An action with no `value` resolves as its own label, not as undefined.
   *     `open()` resolves undefined for a dismissal - Escape, the backdrop -
   *     so an action that also resolved undefined would be indistinguishable
   *     from the user walking away, and a caller would run the affirmative
   *     branch on a cancel.
   *   - Danger is always last, whatever order it was passed in. The
   *     destructive button sits at the end of the row across the whole app
   *     (see .menu-danger in dashboard.css), and a dialog that put it first
   *     because a caller listed it first would put "Delete" under the pointer
   *     that was aiming at "Cancel".
   */
  function normalizeActions(actions) {
    const out = [];
    for (const a of actions || []) {
      if (!a || typeof a !== "object") continue;
      const label = String(a.label == null ? "" : a.label).trim();
      // An unlabelled button is a button nobody can describe, so it is dropped
      // rather than rendered blank.
      if (!label) continue;
      out.push({
        label,
        value: a.value === undefined ? label : a.value,
        kind: KINDS.indexOf(a.kind) === -1 ? "quiet" : a.kind,
      });
    }
    if (!out.length) return [Object.assign({}, DEFAULT_ACTION)];
    const danger = out.filter((a) => a.kind === "danger");
    const rest = out.filter((a) => a.kind !== "danger");
    return rest.concat(danger);
  }

  /**
   * Which action starts focused. -1 when there is nothing to focus.
   *
   * The primary, when there is one. When there is not - a confirm whose
   * affirmative button is the destructive one - focus goes to the first
   * non-danger action instead, so Return does not delete anything the user has
   * not aimed at. A footer of nothing but danger falls back to the first, and
   * Escape still cancels.
   */
  function focusIndex(actions) {
    const list = actions || [];
    if (!list.length) return -1;
    const primary = list.findIndex((a) => a.kind === "primary");
    if (primary !== -1) return primary;
    const safe = list.findIndex((a) => a.kind !== "danger");
    return safe === -1 ? 0 : safe;
  }

  /**
   * Run a textPrompt validator and reduce whatever it returned to "an error
   * string, or null".
   *
   * The contract is deliberately generous about what counts as "fine" -
   * null, undefined, false and an empty string all mean valid - because the
   * natural way to write one of these is `if (bad) return "why";` with no
   * explicit return on the good path, and a helper that treated that undefined
   * as an error would wedge the dialog shut with a blank message.
   *
   * A validator that THROWS is treated as a rejection carrying its message
   * rather than allowed to escape: it is called from a click handler, and an
   * exception there would leave the dialog open with no error shown and the
   * promise unsettled, which is the one outcome this whole module exists to
   * prevent.
   */
  function runValidate(validate, value) {
    if (typeof validate !== "function") return null;
    let err;
    try {
      err = validate(value);
    } catch (e) {
      err = (e && e.message) || "That value is not valid.";
    }
    if (err === null || err === undefined || err === false) return null;
    const text = String(err).trim();
    return text || null;
  }

  root.RATrackerDialogSupport = {
    KINDS,
    DEFAULT_ACTION,
    normalizeActions,
    focusIndex,
    runValidate,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerDialogSupport;
}
