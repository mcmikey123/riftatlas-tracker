/* Rift Atlas Stats Tracker - copy a link, and say that it was copied
 *
 * One helper, shared by every place a share link is handed over: the row's
 * share panel, the shares list, the replay modal's "copy link to this moment",
 * and the standalone viewer's. Four buttons across two surfaces that ship to
 * two different origins, which is exactly the shape that drifts - the same
 * lesson share/repaint.js already learned.
 *
 * The behaviour worth keeping identical is small but easy to get subtly wrong:
 * a copy that fails must leave the user holding the text anyway, and a button
 * that says "Copied" has to go back to saying what it does.
 *
 * share/worker/sync-assets.sh copies this into the Worker's static assets.
 */
(function (root) {
  "use strict";

  // Long enough to be read, short enough that the button is not still lying
  // about its own purpose by the time the next click comes.
  const FLASH_MS = 1500;

  /**
   * Buttons currently showing a message, against the label to put back and the
   * timer that will do it. A WeakMap rather than a data attribute so nothing is
   * written into the DOM, and so a button that is discarded mid-message takes
   * its entry with it.
   */
  const flashing = new WeakMap();

  /**
   * Copy `text`. Resolves true when it landed and false when it did not; never
   * rejects, because every caller's answer to a failure is the same and none of
   * them is "throw". Missing API, insecure context and a refused permission are
   * one outcome here: the user did not get the text.
   */
  function copyText(text, deps) {
    const nav = (deps && deps.navigator) || root.navigator;
    const clip = nav && nav.clipboard;
    if (!clip || typeof clip.writeText !== "function") return Promise.resolve(false);
    try {
      return Promise.resolve(clip.writeText(String(text))).then(
        () => true,
        () => false
      );
    } catch (_) {
      return Promise.resolve(false);
    }
  }

  /**
   * Say `message` on `button`, then put its label back.
   *
   * A second flash while the first is still showing restores the ORIGINAL
   * label, not the message the first one left on screen. Reading the label off
   * the button at call time looks right and is not: two quick clicks leave a
   * button permanently reading "Copied", which then also becomes the label the
   * third click restores.
   */
  function flash(button, message, deps) {
    if (!button) return;
    const timers = (deps && deps.timers) || root;
    const held = flashing.get(button);
    const label = held ? held.label : button.textContent;
    if (held && typeof timers.clearTimeout === "function") timers.clearTimeout(held.timer);
    button.textContent = message;
    const timer = timers.setTimeout(() => {
      flashing.delete(button);
      // The button can go while the message is up - a re-render, a closed
      // modal. `isConnected` is undefined on a test double, which is not
      // "detached", so only an explicit false counts.
      if (button.isConnected !== false) button.textContent = label;
    }, FLASH_MS);
    flashing.set(button, { label, timer });
  }

  /**
   * Copy `text` and report on `button`. Resolves the same boolean `copyText`
   * does, for a caller that wants to do something else as well.
   *
   * `field`, when the surface has one, is the read-only input holding the same
   * text: it is selected before the attempt, so a refused clipboard leaves a
   * manual Ctrl+C ready rather than leaving the user with nothing. A surface
   * without one gets the text in a prompt instead, which is still selectable
   * and copyable from the keyboard. Either way the failure path ends with the
   * text somewhere the user can reach - a button that flashes an apology and
   * does nothing else is the one outcome not worth shipping.
   */
  function copyToButton(text, button, options) {
    const opts = options || {};
    const field = opts.field;
    if (field) {
      field.focus();
      field.select();
    }
    return copyText(text, opts).then((ok) => {
      if (ok) {
        flash(button, "Copied", opts);
        return true;
      }
      flash(button, field ? "Press Ctrl+C" : "Copy failed", opts);
      if (!field) {
        const ask = opts.prompt || (typeof root.prompt === "function" && root.prompt.bind(root));
        if (ask) ask("Copy this link:", String(text));
      }
      return false;
    });
  }

  // Same dual export as store/css-assets.js: a global for the browser, CommonJS
  // for `node --test`.
  const api = { FLASH_MS, copyText, flash, copyToButton };

  root.RAClipboard = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
