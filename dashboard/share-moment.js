/* Rift Atlas Stats Tracker - "copy link to this moment"
 *
 * The replay modal's share button. The standalone viewer's version of this is a
 * string and a clipboard write, because the replay it is watching is already on
 * the endpoint. A local replay has no URL at all, so the first moment shared
 * from a match may have to run the entire pipeline - re-strip, compress,
 * encrypt, upload, verify - which blocks the main thread for about 600 ms and
 * sends about 3.5 MB.
 *
 * So it must not run every time, and it does not: an unexpired share for this
 * match is reused, and reuse costs a base64 decode. Which record that is, and
 * whether there is one at all, is `reusableShare` in share/share-ui-support.js
 * where it is pure and tested. What is here is the storage read, the disclosure
 * and the paint.
 *
 * Reuse deliberately does NOT re-check the endpoint first. The record says the
 * object has days left, and spending a round trip to confirm that would undo
 * the point of reusing; the shares panel has an explicit Re-check for the
 * question "is it still there".
 *
 * This is a second surface onto the state share-panel.js holds, not a second
 * copy of it: the row's own panel is behind the modal and repaints as usual -
 * the point of this is that the thing covering it says the same thing.
 */
(function (root) {
  "use strict";

  const { esc } = root.RATrackerFormat || require("./format.js");
  const SHARE = root.RAShareUI || require("../share/share-ui-support.js");
  const HOSTS = root.RAShareHosts || require("../share/hosts.js");
  const PANEL = root.RATrackerSharePanel || require("./share-panel.js");
  const PIPELINE = root.RATrackerSharePipeline || require("./share-pipeline.js");

  // The modal panel following a share's phases, if one is open.
  let momentFollow = null;

  function paintMomentPanel(matchId) {
    if (!momentFollow || momentFollow.matchId !== matchId) return;
    if (!momentFollow.panel.isConnected) {
      momentFollow = null;
      return;
    }
    const s = PANEL.stateOf(matchId);
    if (!s.phase || s.phase === "idle") return;
    momentFollow.panel.innerHTML = `<p class="share-progress">${esc(
      PANEL.PHASES[s.phase] || "Working…"
    )}</p>`;
  }

  // Every phase change repaints the row's panel; this is what makes the modal's
  // copy follow the same phases without the pipeline knowing this file exists.
  PANEL.onPaint(paintMomentPanel);

  function closeMomentPanel(panel) {
    panel.hidden = true;
    panel.innerHTML = "";
  }

  /* The finished link, offered with its own Copy button rather than only pushed
   * at the clipboard.
   *
   * After an upload the click that started it is seconds past counting as a user
   * gesture and `writeText` would be refused - leaving the link in a fallback
   * dialog, for a share the user did everything right to create. One fresh click
   * on a button beside the link is a better ending, and it is the same read-only
   * field and Copy pairing the row's own panel ends with. The reuse path shows
   * the same thing for the same reason: its clipboard write can be refused too,
   * and a panel that has already closed leaves a prompt over the replay as the
   * only place the link exists. */
  function showMomentLink(panel, link, note) {
    panel.hidden = false;
    panel.innerHTML = `
      <div class="share-link-row">
        <input class="share-link vr-share-link" type="text" readonly spellcheck="false"
               aria-label="Share link opening at this moment" value="${esc(link)}" />
        <button class="rp-btn vr-share-copy">Copy link</button>
      </div>
      <p class="share-note">${esc(note)}</p>`;
    const field = panel.querySelector(".vr-share-link");
    const copy = panel.querySelector(".vr-share-copy");
    copy.addEventListener("click", () => window.RAClipboard.copyToButton(link, copy, { field }));
    field.focus();
    field.select();
    return field;
  }

  /* An existing share, handed over instead of uploading a second copy of the
   * same replay. Nothing is uploaded and no record is written: a second record
   * for the same object would be a duplicate row in the shares panel claiming to
   * be a second share.
   *
   * What it has left is said out loud, in the wording the match row's own reuse
   * uses - `SHARE.reuseNotice`, so the two buttons cannot drift into describing
   * the same decision differently. */
  function offerReusedLink(panel, button, record, atSeconds, atSpeed) {
    const link = PANEL.linkFor(record, atSeconds, atSpeed);
    const field = showMomentLink(panel, link, SHARE.reuseNotice(record, Date.now()));
    window.RAClipboard.copyToButton(link, button, { field });
  }

  /* Entry point handed to the modal. `atMs` was read at the click, so it names
   * the moment the user meant even when an upload happens in between. */
  async function shareMoment({ atMs, atSpeed, button, panel }, match) {
    const atSeconds = HOSTS.toLinkSeconds(atMs);
    const stored = await window.RATrackerStorage.readShares();
    const record = SHARE.reusableShare(stored, match.id, Date.now());
    if (record) return offerReusedLink(panel, button, record, atSeconds, atSpeed);
    // Nothing live to reuse, so this is a first upload. The disclosure comes
    // first and the upload is a second, deliberate click - the same two steps
    // the row's own share panel takes, because the thing being consented to is
    // the same: a replay carrying an opponent's display name and the match chat
    // leaves this machine, and it cannot be unshared afterwards.
    askThenShareMoment(match.id, atSeconds, atSpeed, button, panel);
  }

  function askThenShareMoment(matchId, atSeconds, atSpeed, button, panel) {
    panel.hidden = false;
    panel.innerHTML = `${PANEL.DISCLOSURE}
      <div class="vr-share-actions">
        <button class="rp-btn vr-share-go">Create share link</button>
        <button class="rp-btn vr-share-cancel">Cancel</button>
      </div>`;
    panel.querySelector(".vr-share-cancel").addEventListener("click", () => closeMomentPanel(panel));
    const go = panel.querySelector(".vr-share-go");
    go.addEventListener("click", async () => {
      // Disabled synchronously: the re-read below is asynchronous, and a second
      // click while it is out would start a second upload of the same replay.
      go.disabled = true;
      /* The reuse decision was made on the first click, which may be minutes
       * back - long enough for a share of this match to have landed from the
       * row's own panel behind the modal. Uploading now would put a second 3.5 MB
       * object on the endpoint and write a second record, both undeletable for
       * seven days, which is exactly what reuse exists to prevent. */
      const stored = await window.RATrackerStorage.readShares();
      const landed = SHARE.reusableShare(stored, matchId, Date.now());
      // The panel's own buttons go with its content, so a Cancel or a closed
      // modal during the read detaches this one.
      if (!go.isConnected) return;
      if (landed) return offerReusedLink(panel, button, landed, atSeconds, atSpeed);

      button.disabled = true;
      momentFollow = { matchId, panel };
      panel.innerHTML = `<p class="share-progress">${esc(PANEL.PHASES.preparing)}</p>`;
      PIPELINE.beginShare(matchId).then((made) => {
        if (momentFollow && momentFollow.panel === panel) momentFollow = null;
        button.disabled = false;
        if (!panel.isConnected) return; // the modal was closed while it ran
        if (!made) {
          // beginShare has already turned the failure into a message; showing
          // it here as well is what makes the modal a complete surface rather
          // than one that needs the row behind it read too.
          const s = PANEL.stateOf(matchId);
          panel.innerHTML = `<p class="share-error">${esc(s.error || SHARE.MESSAGES.unprepared)}</p>`;
          return;
        }
        showMomentLink(
          panel,
          PANEL.linkFor(made.record, atSeconds, atSpeed),
          "Uploaded and verified. Later moments from this match reuse it — no second upload, " +
            "and no second copy on the endpoint."
        );
      });
    });
  }

  root.RATrackerShareMoment = { shareMoment };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerShareMoment;
}
