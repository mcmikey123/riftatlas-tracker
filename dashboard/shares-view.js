/* Rift Atlas Stats Tracker - the Shared links view
 *
 * What has been shared from this browser, and what became of it.
 *
 * The panel exists because there is no delete button and cannot be one: a
 * share is served until the endpoint's own 7-day lifecycle rule removes it,
 * and the payload carries an opponent's display name and the match chat. The
 * least this can do is keep an honest register of what is still out there.
 *
 * Re-check reads four bytes back off the endpoint - share-pipeline.js's
 * `fetchObjectHead`, the same read that verifies a fresh upload. Clear removes
 * a local record only; it deletes nothing, and the copy underneath an expired
 * record is already gone or going.
 *
 * The pure parts - the record filter, the expiry wording and the outcome-to-
 * message mapping - are in share/share-ui-support.js and are tested. What a row
 * says given a record, a clock and a re-check answer is decidable too, so
 * `listRowHtml`, `matchLabel` and `recheckHtml` take those as arguments and are
 * tested here. What is left is DOM and network.
 */
(function (root) {
  "use strict";

  const { esc, champ, fmtStamp } = root.RATrackerFormat || require("./format.js");
  const SHARE = root.RAShareUI || require("../share/share-ui-support.js");
  const PANEL = root.RATrackerSharePanel || require("./share-panel.js");
  const PIPELINE = root.RATrackerSharePipeline || require("./share-pipeline.js");

  /* Nothing here dereferences a query result directly: this view's markup is
   * part of the redesign, so an element it reaches for may be moved or renamed
   * underneath it, and one unguarded access during a render would take the rest
   * of the panel with it. Same idiom, and same reason, as legacy.js. */
  const $ = (s) => document.querySelector(s);
  const setHtml = (sel, html) => {
    const el = $(sel);
    if (el) el.innerHTML = html;
  };

  let shares = [];
  // objectId -> {busy} or a describeRecheck() result. Kept outside the DOM so a
  // re-render cannot lose an answer that was just given.
  const recheckState = new Map();

  // What the nav count and the "you have shared this replay" warning read.
  const list = () => shares;

  // Which match a share came from, and whether the page may write. Supplied by
  // mount(), because both are the dashboard's state and neither is a property
  // of a share.
  let matchById = () => null;
  let readOnly = () => false;

  function refresh() {
    if (readOnly()) return;
    chrome.storage.local.get({ shares: [] }, (data) => {
      shares = SHARE.readShareList(data && data.shares);
      // Records go on their own - pruned on write, or cleared with everything
      // else - so an answer held for one that is no longer listed is an answer
      // about a row that will never be drawn again.
      const listed = new Set(shares.map((r) => r.objectId));
      for (const objectId of [...recheckState.keys()]) {
        if (!listed.has(objectId)) recheckState.delete(objectId);
      }
      renderPanel();
    });
  }

  /**
   * Which match this came from. A share outlives the match record - deleting a
   * match cannot reach the copy on the endpoint - so an orphaned row says so
   * rather than showing a bare id nobody can place.
   *
   * The match is passed in rather than looked up, because it is the dashboard's
   * state and not this decision's input. Deliberately NOT shared with
   * replay-panel.js's `visualLabel`: that one dates a row by the recording's own
   * clock and an orphan there still has a timestamp worth showing, where an
   * orphan here has nothing left to say but so.
   */
  function matchLabel(record, match) {
    if (!match) return "match no longer in your history";
    const when = fmtStamp(match.startedAt);
    return `${when} · ${champ(match.myChampion || match.myLegend)} vs ${champ(
      match.opponentChampion || match.opponentLegend
    )}`;
  }

  /** What a re-check answered, or nothing at all when it has not been asked. */
  function recheckHtml(state) {
    if (!state) return "";
    if (state.busy) return '<p class="sh-msg">Asking the endpoint…</p>';
    return `<p class="sh-msg"><span class="sh-state sh-${esc(state.state)}">${esc(state.label)}</span>
      ${esc(state.message)}</p>`;
  }

  /**
   * One row of the list. `recheck` is this share's entry in the re-check state,
   * or undefined; `label` is what `matchLabel` made of the match behind it.
   *
   * Only an expired row offers "Clear from list": the confirm behind it is
   * worded for a share whose time is already up, and offering it on a live one
   * would invite someone to throw away the only copy of a working key.
   */
  function listRowHtml(record, now, label, recheck) {
    const expired = SHARE.isExpired(record, now);
    const oid = esc(record.objectId);
    return `<tr class="${expired ? "sh-expired-row" : ""}">
        <td>${esc(label)}</td>
        <td class="sh-when">${esc(fmtStamp(record.createdAt))}</td>
        <td class="sh-when">${
          expired
            ? `<span class="sh-state sh-expired">${esc(SHARE.expiryText(record, now))}</span>`
            : esc(SHARE.expiryText(record, now))
        }</td>
        <td class="sh-link-cell">
          ${PANEL.shareLinkRowHtml(PANEL.linkFor(record), record.objectId, {
            label,
            field: "sharelistlink",
            copy: "sharelistcopy",
            copyText: "Copy",
          })}
        </td>
        <td class="sh-actions">
          <button class="rp-btn" data-sharerecheck="${oid}" ${
            (recheck || {}).busy ? "disabled" : ""
          }>Re-check</button>
          ${
            expired
              ? `<button class="rp-btn sh-forget" data-shareforget="${oid}"
                     title="Forget this record. It cannot delete the copy on the endpoint - that expires on its own.">Clear from list</button>`
              : ""
          }
          <div data-sharestatus="${oid}" aria-live="polite">${recheckHtml(recheck)}</div>
        </td>
      </tr>`;
  }

  const rowHtml = (record, now) =>
    listRowHtml(record, now, matchLabel(record, matchById(record.matchId)), recheckState.get(record.objectId));

  function renderPanel() {
    const panel = $("#sharesPanel");
    if (!panel) return;
    // An archive view is a file, not this browser's data; its matches have no
    // relationship to what was shared from here.
    panel.hidden = readOnly();
    if (panel.hidden) return;
    const now = Date.now();
    setHtml(
      "#sharesTable tbody",
      shares.length
        ? shares.map((r) => rowHtml(r, now)).join("")
        : `<tr><td colspan="5" class="empty">No share links have been created from this browser.
           Open a match with a replay and choose “share a link”.</td></tr>`
    );
  }

  /** Repaint one row's outcome in place, so re-checking keeps keyboard focus. */
  function paintRecheck(objectId) {
    const cell = $(`[data-sharestatus="${CSS.escape(objectId)}"]`);
    if (cell) cell.innerHTML = recheckHtml(recheckState.get(objectId));
    const button = $(`[data-sharerecheck="${CSS.escape(objectId)}"]`);
    if (button) button.disabled = !!(recheckState.get(objectId) || {}).busy;
  }

  function recheckShare(objectId) {
    const record = shares.find((r) => r.objectId === objectId);
    if (!record || (recheckState.get(objectId) || {}).busy) return;
    recheckState.set(objectId, { busy: true });
    paintRecheck(objectId);
    const settle = (outcome) => {
      // The row can go while the endpoint is answering - cleared from the list,
      // or pruned by a write. refresh() drops answers for rows it no longer
      // lists, so an answer stored after that would be an entry nothing paints
      // and nothing removes.
      if (!shares.some((r) => r.objectId === objectId)) return;
      recheckState.set(objectId, SHARE.describeRecheck(outcome));
      paintRecheck(objectId);
    };
    PIPELINE.fetchObjectHead(record.endpoint, record.objectId).then(
      (head) =>
        settle({
          reached: head.reached,
          status: head.status,
          magic: SHARE.hasShareMagic(head.bytes),
        }),
      (err) => {
        console.warn("[RA-Tracker] re-checking a share failed:", err);
        settle({ reached: false });
      }
    );
  }

  /* Forgetting a record is the only thing this list can remove. The object on
   * the endpoint is not ours to delete - there is no route for it - so the
   * wording must never suggest this unshares anything. */
  function forgetShare(objectId) {
    if (readOnly()) return;
    const record = shares.find((r) => r.objectId === objectId);
    // Expired only, which is what the row offers - the wording below is about a
    // share whose time is already up and must never be shown for a live one.
    if (!record || !SHARE.isExpired(record, Date.now())) return;
    window.RATrackerDialog.confirm({
      title: "Remove this expired share from the list?",
      body:
        "<p>This forgets the local record only. It cannot delete the copy on the endpoint — that " +
        "expired on its own, and the endpoint deletes it within about a day of expiring.</p>" +
        "<p>The record is the only place this share's decryption key is kept, so the link " +
        "can't be rebuilt afterwards.</p>",
      confirmLabel: "Clear from list",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      chrome.storage.local.get({ shares: [] }, (data) => {
        // Pruned on this write like any other. Everything it removes alongside
        // the chosen record is a share whose object the endpoint deleted days
        // ago, so no row disappears that could still have been opened.
        //
        // Same non-atomic get-then-set as rememberShare, and the same race with
        // a second dashboard tab. See the note there.
        const kept = SHARE.pruneShares(data.shares, Date.now()).filter(
          (s) => !(s && s.objectId === objectId)
        );
        window.RATrackerStorage.writeShares(kept, () => {
          recheckState.delete(objectId);
          refresh();
        });
      });
    });
  }

  // ---- events this view owns ---------------------------------------------

  /* Keyed by object id, which is what identifies a share - a match can have
   * been shared more than once, so the match id would not do. Nothing else on
   * the page listens for these three attributes. */
  function mount(deps) {
    matchById = deps.matchById;
    readOnly = deps.readOnly;

    document.addEventListener("click", (e) => {
      const listCopyId = e.target?.dataset?.sharelistcopy;
      if (listCopyId) {
        const record = shares.find((r) => r.objectId === listCopyId);
        if (record) {
          window.RAClipboard.copyToButton(PANEL.linkFor(record), e.target, {
            field: $(`[data-sharelistlink="${CSS.escape(listCopyId)}"]`),
          });
        }
        return;
      }
      const recheckId = e.target?.dataset?.sharerecheck;
      if (recheckId) {
        recheckShare(recheckId);
        return;
      }
      const forgetId = e.target?.dataset?.shareforget;
      if (forgetId) forgetShare(forgetId);
    });
  }

  root.RATrackerSharesView = {
    list,
    refresh,
    renderPanel,
    matchLabel,
    recheckHtml,
    listRowHtml,
    mount,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerSharesView;
}
