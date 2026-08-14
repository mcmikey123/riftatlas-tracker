/* Rift Atlas Stats Tracker - the two things we draw on the game page.
 *
 * A confirmation toast when a match ends, and a banner when this script has been
 * orphaned by an extension update. Nothing here decides anything: the toast is
 * handed a finished record and the two callbacks its buttons stand for, and the
 * banner is a sentence. Both are injected into a page we do not own, which is
 * the concern they share - one z-index, one block class, one lifetime.
 *
 * Element ids and the block class are spelled out as literals at every point of
 * use rather than pulled from constants. test/vendor-contract.test.js scans this
 * file for `.id = "ra-tracker-…"` and requires the block class to appear beside
 * it: that class is the only thing keeping our own UI out of the visual replay,
 * and rrweb's blockSelector - the alternative - crashes on text nodes.
 */
(function (root) {
  "use strict";

  const TOAST_MS = 30000; // how long the confirmation toast stays up

  // ---------- orphaned-script detection (extension updated under us) ----------

  let orphanBannerShown = false;

  function isOrphaned() {
    try {
      return !chrome.runtime || !chrome.runtime.id;
    } catch (_) {
      return true;
    }
  }

  function showOrphanBanner() {
    if (orphanBannerShown) return;
    orphanBannerShown = true;
    const el = document.createElement("div");
    el.id = "ra-tracker-orphan";
    el.className = "ra-tracker-block"; // keeps our own UI out of the visual replay
    el.textContent =
      "Rift Atlas Tracker was updated — REFRESH THIS TAB to resume recording. Matches played before refreshing will NOT be saved.";
    el.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
      "background:#7c2d2d;color:#fff;font:600 13px/1.4 system-ui,sans-serif;" +
      "padding:8px 14px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.5);cursor:pointer;";
    el.title = "Click to dismiss";
    el.addEventListener("click", () => el.remove());
    (document.body || document.documentElement).appendChild(el);
  }

  /* The banner blames an extension update, so it is only honest once the context
   * really is gone. A storage write that throws for any other reason gets the
   * console line and nothing else. */
  function reportStorageFailure(what, err) {
    console.error("[RA-Tracker] " + what, err);
    if (isOrphaned()) showOrphanBanner();
  }

  // ---------- end-of-match confirmation toast (manual override) ----------

  let toastEl = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /**
   * @param {object} record - the finished match, already saved.
   * @param {{onResult: function(string, string), onDiscard: function(string)}}
   *   actions - what the buttons mean. OK is a result too: confirming is the
   *   player saying so, which is what makes it "manual".
   */
  function showConfirmToast(record, actions) {
    removeToast();
    const el = document.createElement("div");
    el.id = "ra-tracker-toast";
    el.className = "ra-tracker-block"; // keeps our own UI out of the visual replay
    const detected =
      record.result === "win"
        ? "WIN detected"
        : record.result === "loss"
        ? "LOSS detected"
        : "Result not detected";
    el.innerHTML = `
      <div class="rat-title">Rift Atlas Tracker</div>
      <div class="rat-sub">${escapeHtml(record.myChampion || "You")} vs ${escapeHtml(
      record.opponentChampion || "opponent"
    )} &mdash; <b class="rat-${record.result}">${detected}</b></div>
      <div class="rat-row">
        <button data-r="win">Win</button>
        <button data-r="loss">Loss</button>
        <button data-r="draw">Draw</button>
        <button data-r="__discard" class="rat-discard">Don't record</button>
        <button data-r="__ok" class="rat-ok">OK</button>
      </div>
      <div class="rat-hint">Wrong? Click the correct result to override. Auto-closes in 30s.</div>
    `;
    el.addEventListener("click", (e) => {
      const r = e.target?.dataset?.r;
      if (!r) return;
      if (r === "__discard") actions.onDiscard(record.id);
      else if (r === "__ok") actions.onResult(record.id, record.result); // confirm = manual
      else actions.onResult(record.id, r);
      removeToast();
    });
    document.body.appendChild(el);
    toastEl = el;
    setTimeout(removeToast, TOAST_MS);
  }

  function removeToast() {
    if (toastEl) {
      toastEl.remove();
      toastEl = null;
    }
  }

  /* Is this node part of the toast? It prints the detected result in words, so
   * end detection reading it back would end the match the toast is asking
   * about. */
  function isOwnToast(node) {
    const host = node && node.nodeType === 3 ? node.parentElement : node;
    return !!(host && host.closest && host.closest("#ra-tracker-toast"));
  }

  root.RATPageUI = {
    isOrphaned,
    showOrphanBanner,
    reportStorageFailure,
    showConfirmToast,
    removeToast,
    isOwnToast,
    escapeHtml,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATPageUI;
}
