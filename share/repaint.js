/* Rift Atlas Stats Tracker - yield to the compositor
 *
 * One helper, shared by the two places that build or open a share: the
 * dashboard's Share control and the standalone viewer. Both run a handful of
 * steps that block the main thread for hundreds of milliseconds - JSON,
 * deflate, decrypt - and both have to let the browser paint the label saying
 * which step is running before that step begins.
 *
 * The subtlety, and the reason this is one file rather than two copies: a
 * backgrounded tab never fires requestAnimationFrame. Waiting on a frame alone
 * leaves the whole pipeline parked the moment the user switches tabs, which in
 * the dashboard also holds the "one share at a time" lock and disables every
 * other match's Share button until the tab is looked at again. The timer is the
 * floor that guarantees progress; the frame is the fast path when there is one.
 *
 * share/worker/sync-assets.sh copies this into the Worker's static assets.
 */
(function (root) {
  "use strict";

  // Long enough to be a real paint opportunity on a slow frame, short enough
  // that a hidden tab still walks through its steps at a sensible pace.
  const REPAINT_FLOOR_MS = 250;

  /**
   * Resolve after the browser has had a chance to paint. `scheduler` defaults
   * to the global object and exists so this is testable without a DOM; it needs
   * `setTimeout`, and uses `requestAnimationFrame` when there is one.
   */
  function repaint(scheduler) {
    const w = scheduler || root;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return; // whichever of the two arrives second is a no-op
        done = true;
        resolve();
      };
      // A frame, then a task: the frame paints what was just set, the task lets
      // the next step start after that paint rather than inside it.
      if (typeof w.requestAnimationFrame === "function") {
        w.requestAnimationFrame(() => w.setTimeout(finish, 0));
      }
      w.setTimeout(finish, REPAINT_FLOOR_MS);
    });
  }

  // Same dual export as store/css-assets.js: a global for the browser, CommonJS
  // for `node --test`.
  const api = { REPAINT_FLOOR_MS, repaint };

  root.RARepaint = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
