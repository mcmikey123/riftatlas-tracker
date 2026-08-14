/* Rift Atlas Stats Tracker - the share panel under a match
 *
 * One component with one state per match id, rendered in as many places as the
 * match appears: the expanded row in Matches, and the row in the Replays list.
 * This file owns that state, the wording around it and the markup - not the
 * upload, which is share-pipeline.js.
 *
 * Turning a replay into a link is a one-way door. The link is a bearer token,
 * there is no revocation, and the object only goes away when the endpoint's
 * 7-day lifecycle rule removes it. So the panel says all of that first, every
 * time it paints, and the upload is a second, deliberate click.
 *
 * The state is held OUTSIDE the DOM. A re-render rebuilds the whole history
 * table, and a share that is mid-flight or a link that has just been produced
 * must survive that. Openness is tracked separately from the state, so
 * collapsing a panel hides a link rather than discarding it.
 *
 * What a given state should say is decidable from that state alone, so
 * `shareBoxHtml` takes it - and the clock - as arguments and is tested.
 * `share/share-ui-support.js` holds the decisions underneath it.
 */
(function (root) {
  "use strict";

  // format.js, hosts.js and share-ui-support.js are loaded first by
  // dashboard.html; the requires are for node.
  const { esc } = root.RATrackerFormat || require("./format.js");
  const SHARE = root.RAShareUI || require("../share/share-ui-support.js");
  const HOSTS = root.RAShareHosts || require("../share/hosts.js");

  const PHASES = {
    preparing: "Reading the replay…",
    stripping: "Deduplicating stylesheets…",
    encrypting: "Compressing and encrypting…",
    uploading: "Uploading…",
    verifying: "Verifying…",
  };

  /* Reassurance first, because the encryption property is real and is the whole
   * point; the caveats stay present but secondary. Self-hosting is deliberately
   * not mentioned - that is documentation, and it only confuses someone who is
   * standing at the point of sharing.
   *
   * The caveat says "everything on your screen" rather than listing fields
   * because that is literally what a replay is: capture/dom-recorder.js records
   * the DOM with only input values masked, so the sharer's own display name and
   * whatever else was on the page travel with it. Naming two items would read as
   * an exhaustive list and understate what is being handed over. */
  const DISCLOSURE = `
    <p class="share-lead">End-to-end encrypted — only people with the link can view this replay.</p>
    <p class="share-caveats">
      The replay shows everything that was on your screen during the match, including your
      opponent's display name and the match chat, and anyone the link reaches can open it. It
      expires after ${SHARE.SHARE_TTL_DAYS} days, and it can't be unshared before then.
    </p>`;

  // matchId -> {phase, link, error, retry, createdAt}, and which panels are
  // expanded. Both outlive any particular rendering of the row.
  const shareState = new Map();
  const shareOpen = new Set();

  /** The share state for a match, or an empty one. Never null. */
  const stateOf = (matchId) => shareState.get(matchId) || {};

  const isOpen = (matchId) => shareOpen.has(matchId);
  const open = (matchId) => void shareOpen.add(matchId);
  const close = (matchId) => void shareOpen.delete(matchId);
  const toggle = (matchId) => (shareOpen.has(matchId) ? close(matchId) : open(matchId));

  /* The link a share record rebuilds to. `atSeconds` is optional and omitted
   * from the link when absent, so the shares list keeps producing exactly the
   * link it always did; only "copy a link to this moment" passes one. Always
   * the record's own endpoint, never the one in Settings - a share uploaded
   * before that setting changed still lives where it was put. */
  function linkFor(record, atSeconds) {
    return HOSTS.buildLink({
      endpoint: record.endpoint,
      objectId: record.objectId,
      keyBytes: HOSTS.fromBase64Url(record.key),
      atSeconds,
    });
  }

  /* The read-only link field and its Copy button. Both the panel under a match
   * and the shares list render one, and as two copies they drifted - only the
   * list's carried the field's accessible name, leaving the panel's input
   * announced as nothing but "edit text". One builder, so the next change
   * reaches both.
   *
   * `field` and `copy` name the data attributes, because each caller keys its
   * rows differently: the panel by match id, the list by object id, since a
   * match can have been shared more than once. That is all that still differs. */
  function shareLinkRowHtml(link, id, { label, field, copy, copyText }) {
    return `<div class="share-link-row">
          <input class="share-link" type="text" readonly spellcheck="false"
                 aria-label="Share link for ${esc(label)}"
                 data-${field}="${esc(id)}" value="${esc(link)}" />
          <button class="rp-btn" data-${copy}="${esc(id)}">${esc(copyText)}</button>
        </div>`;
  }

  /**
   * What one share state says, in full: the disclosure and then the state.
   *
   * `now` is passed rather than read from the clock, so the three things this
   * says about time - when a fresh share expires, what a reused one has left,
   * and which of the two is being shown - are decidable without one.
   */
  function shareBoxHtml(s, matchId, now) {
    let body;
    if (s.link) {
      const expires = new Date(s.createdAt + SHARE.SHARE_TTL_MS);
      /* The error has to render here too, not only in the no-link branch below.
       * "Create a new link anyway" is offered while a link is on screen, and the
       * refusals it can hit - another match already uploading, or a broken stored
       * endpoint - set an error without clearing the link, so this branch is the
       * one that paints. Without this the button just re-enables itself and
       * nothing else happens, however many times it is pressed. Clearing the link
       * instead would throw away the very thing the user is looking at. */
      body = `
        ${s.error ? `<p class="share-error">${esc(s.error)}</p>` : ""}
        ${shareLinkRowHtml(s.link, matchId, {
          label: "this match",
          field: "sharelink",
          copy: "sharecopy",
          copyText: "Copy link",
        })}
        ${
          s.reuse
            ? `<p class="share-note">${esc(SHARE.reuseNotice(s.reuse, now))}</p>
        <button class="rp-btn share-again" data-sharenew="${esc(matchId)}"
                title="Upload this replay again for a full ${SHARE.SHARE_TTL_DAYS} days. The copy already on the endpoint stays there until it expires.">Create a new link anyway</button>`
            : `<p class="share-note">Uploaded and verified. Expires ${esc(
                expires.toLocaleDateString()
              )}.</p>`
        }`;
    } else if (s.phase && s.phase !== "idle") {
      body = `<p class="share-progress">${esc(PHASES[s.phase] || "Working…")}</p>`;
    } else {
      body = `${s.error ? `<p class="share-error">${esc(s.error)}</p>` : ""}
        ${
          s.error && !s.retry
            ? ""
            : `<button class="rp-btn" data-sharego="${esc(matchId)}">${
                s.error ? "Try again" : "Create share link"
              }</button>`
        }`;
    }
    return DISCLOSURE + body;
  }

  const shareBoxInner = (matchId) => shareBoxHtml(stateOf(matchId), matchId, Date.now());

  /** Repaint one match's panel in place. A collapsed row simply has none. */
  function paintShare(matchId) {
    /* querySelectorAll, not querySelector: the same match can have a panel in
     * the expanded row AND in the Replays list at the same time, and updating
     * only the first in document order would leave the other frozen on a phase
     * it had already left. */
    const boxes = document.querySelectorAll(`[data-sharebox="${CSS.escape(matchId)}"]`);
    if (!boxes.length) return;
    for (const box of boxes) paintOneShareBox(box, matchId);
  }

  function paintOneShareBox(box, matchId) {
    // Whether the panel is open is the toggle's business and beginShare's, not
    // a repaint's: a paint that forces it open means setShare can never update
    // a collapsed panel without reopening it.
    box.hidden = !shareOpen.has(matchId);
    box.innerHTML = shareBoxInner(matchId);
  }

  /* Anything else that has to follow a share's phases. The replay modal's
   * "copy link to this moment" registers one: its panel sits over the row's
   * own and has to say the same thing. Registered rather than called by name so
   * the modal can depend on this file without this file depending on it. */
  const watchers = new Set();
  const onPaint = (fn) => void watchers.add(fn);

  function setShare(matchId, patch) {
    shareState.set(matchId, Object.assign({}, shareState.get(matchId), patch));
    paintShare(matchId);
    for (const watcher of watchers) watcher(matchId);
  }

  root.RATrackerSharePanel = {
    PHASES,
    DISCLOSURE,
    stateOf,
    isOpen,
    open,
    close,
    toggle,
    linkFor,
    shareLinkRowHtml,
    shareBoxHtml,
    shareBoxInner,
    paintShare,
    setShare,
    onPaint,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerSharePanel;
}
