/* Rift Atlas Stats Tracker - the Replays view
 *
 * Every visual recording on disk, what each one cost, and the two things that
 * can be done to one: play it, or delete it.
 *
 * This file also holds the INDEX behind those recordings - which matches have
 * one, how large they are, and what the shared stylesheets cost - because that
 * index is one query for the whole history and every reader of it is here or
 * one call away. The Matches view asks `hasVisual` before it draws a Play
 * button, and the nav card asks for the totals; both go through legacy.js's
 * bridge, which forwards to this file rather than keeping a second copy.
 *
 * What a record SAYS about itself - whether it can be played, what its state
 * means in words, which counters were measured - is replay-panel.js, where it
 * is pure and tested. What is here is the markup around it, the message
 * channel to the service worker, and the two confirms.
 *
 * Deleting is the sharp edge: a recording is the match's own markup, opponent
 * name and chat, it is in no export and no archive, and nothing restores it.
 * So the confirm says what survives, the delete refuses while an upload is
 * reading the same recording, and a replay that has been shared says that its
 * shared copy is not ours to delete.
 */
(function (root) {
  "use strict";

  // All loaded before this file by dashboard.html; the requires are for node.
  const { esc, fmtBytes, fmtCount, fmtMs } = root.RATrackerFormat || require("./format.js");
  const PANEL = root.RATrackerReplayPanel || require("./replay-panel.js");
  const NOTES = root.RATrackerReplayNotes || require("./replay-notes.js");
  const SHARE_PANEL = root.RATrackerSharePanel || require("./share-panel.js");
  const SHARE_PIPELINE = root.RATrackerSharePipeline || require("./share-pipeline.js");
  const SHARES_VIEW = root.RATrackerSharesView || require("./shares-view.js");
  const { unreadableReason } = root.RAShareUI || require("../share/share-ui-support.js");
  const { say, ask } = root.RATrackerNotify || require("./notify.js");

  const { statOf, sumStat, visualStateCell, playable } = PANEL;

  /* Nothing below dereferences a query result directly: this view's markup is
   * part of the redesign and may be moved or renamed underneath it, and one
   * unguarded access during a render would take the rest of the panel with it.
   * Same idiom, and same reason, as legacy.js. */
  const $ = (s) => document.querySelector(s);
  const setHtml = (sel, html) => {
    const el = $(sel);
    if (el) el.innerHTML = html;
  };

  // Supplied by mount(). The match array and the page's repaint are the
  // dashboard's, and the replay reader is built in legacy.js against the same
  // IndexedDB the service worker writes - see the note there.
  let matches = () => [];
  let readOnly = () => false;
  let render = () => {};
  let readReplay = () => Promise.resolve(null);

  // ---- the index ---------------------------------------------------------

  // Which matches have a visual recording, and what each one cost. Asked once
  // for the whole history - never per row - and null until the service worker
  // has answered. The same reply feeds the Visual buttons and the diagnostics
  // panel, so opening the dashboard costs one query, not two.
  let visualIds = null;
  let visualRecords = [];
  let visualAssets = { count: 0, bytes: 0 };
  // Mirrors the retention setting, so the panel can project what keeping that
  // many matches costs. Written by settings-capture.js, which owns the field.
  let keepMatches = 25;

  function ensureVisualIds() {
    // Set before the reply lands, so a re-render can't fire a second query.
    if (visualIds !== null || readOnly()) return;
    visualIds = new Set();
    chrome.runtime.sendMessage({ type: "ra:visual:list" }, (reply) => {
      if (chrome.runtime.lastError || !reply || !reply.ok) return;
      visualRecords = (reply.replays || []).filter((r) => r && r.matchId);
      visualAssets = reply.assets || visualAssets;
      renderPanel();
      const ids = visualRecords.filter((r) => r.chunkCount > 0).map((r) => r.matchId);
      if (!ids.length) return;
      visualIds = new Set(ids);
      render();
    });
  }

  const hasVisual = (id) => !readOnly() && visualIds !== null && visualIds.has(id);

  /* Deleting a match has to reach the service worker's IndexedDB too: the
   * visual recording is the match's own markup, opponent name and chat included,
   * and once the match record is gone nothing in the dashboard can reach or show
   * it again. The local state is dropped immediately so the panel and the Visual
   * buttons match what was just deleted, without waiting for a re-list. */
  function forgetVisual(matchId) {
    chrome.runtime.sendMessage({ type: "ra:visual:delete", matchId }, () => {
      void chrome.runtime.lastError; // the tracker carries on either way
    });
    if (visualIds) visualIds.delete(matchId);
    visualRecords = visualRecords.filter((r) => r.matchId !== matchId);
    renderPanel();
  }

  /** Wipe every visual recording, for the two clear-everything paths. */
  function forgetAllVisual() {
    chrome.runtime.sendMessage({ type: "ra:visual:clear" }, () => {
      void chrome.runtime.lastError;
    });
    visualIds = new Set();
    visualRecords = [];
    visualAssets = { count: 0, bytes: 0 };
    renderPanel();
  }

  /* Read by the nav card through legacy.js's bridge, which is why they are
   * getters: the arrays are replaced wholesale by every list and every delete,
   * so a caller holding one would be describing a state that has passed. */
  const records = () => visualRecords;
  const assets = () => visualAssets;
  const keepCount = () => keepMatches;
  /* The panel projects disk use from the retention count, so being told it is
   * also being told to repaint. */
  const setKeepMatches = (n) => {
    keepMatches = n;
    renderPanel();
  };

  // ---- the table ---------------------------------------------------------

  /* No approved glyph exists for "share", and an emoji renders differently on
   * every platform - so an inline SVG, shipped in the repo, which is what the
   * design asks for when a character will not do. currentColor so it follows
   * the button's own hover state. */
  const SHARE_MARK =
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'd="M6.5 9.5a3 3 0 0 0 4.2 0l2.1-2.1a3 3 0 0 0-4.2-4.2l-1 1M9.5 6.5a3 3 0 0 0-4.2 0l-2.1 2.1' +
    'a3 3 0 0 0 4.2 4.2l1-1"/></svg>';

  /**
   * One row of the table.
   *
   * `label` is what replay-panel.js made of the record and the match behind it,
   * and `open` whether the share panel for this match is showing - both passed
   * in, because neither is a property of the recording.
   *
   * The match label opens the replay: it is the thing on the row that names a
   * match, so it is what a reader reaches for - and the modal is already one
   * click away from Matches, so this is a shortcut rather than a new power. A
   * record with nothing to play stays as plain text rather than becoming a
   * button that opens a modal only to apologise.
   */
  function replayRowHtml(record, label, open) {
    const name = esc(label);
    const id = esc(record.matchId);
    return `<tr>
        <td>${
          playable(record)
            ? `<button class="vd-open" data-visual="${id}"
                       title="Play this replay">${name}</button>
               <button class="vd-icon ${open ? "on" : ""}" data-share="${id}"
                       aria-label="Share a link to this replay"
                       title="Turn this replay into an encrypted link anyone can open">${SHARE_MARK}</button>`
            : name
        }</td>
        <td>${fmtBytes(record.compressedBytes)}</td>
        <td>${fmtCount(record.chunkCount)}</td>
        <td>${fmtCount(statOf(record, "keyframes"))}</td>
        <td>${fmtBytes(statOf(record, "meanDeltaBytes"))}</td>
        <td>${fmtMs(statOf(record, "captureP50Ms"))}</td>
        <td>${fmtMs(statOf(record, "captureMaxMs"))}</td>
        ${visualStateCell(record)}
        <td class="vd-actions"><button class="vd-icon vd-del" data-visualdel="${id}"
              aria-label="Delete this recording"
              title="Delete this recording. The match itself is kept.">✕</button></td>
      </tr>${
        // The share panel is one component with one state per match id, so the
        // copy here and the copy in the expanded match row show the same phase.
        // It sits in its own full-width row rather than in the first cell,
        // which would drag the numeric columns out of line.
        open
          ? `<tr class="vd-share-row"><td colspan="9">
               <div class="share-box" data-sharebox="${id}">${SHARE_PANEL.shareBoxInner(record.matchId)}</div>
             </td></tr>`
          : ""
      }`;
  }

  /**
   * The footer: what the table adds up to, and what retention costs.
   *
   * Every replay is captured at full fidelity, so the mean is the only figure
   * needed to price a different keep count - which is what the third row does,
   * and why it is drawn from the retention setting rather than from the rows.
   */
  function totalsHtml(records_, assets_, keep) {
    const bytes = records_.reduce((n, r) => n + (Number(r.compressedBytes) || 0), 0);
    const chunks = records_.reduce((n, r) => n + (Number(r.chunkCount) || 0), 0);
    const mean = records_.length ? bytes / records_.length : 0;
    return `
      <tr class="vd-total">
        <td>Total · ${records_.length} match${records_.length === 1 ? "" : "es"}</td>
        <td>${fmtBytes(bytes)}</td>
        <td>${chunks}</td>
        <td>${fmtCount(sumStat(records_, "keyframes"))}</td>
        <td colspan="5"></td>
      </tr>
      <tr class="vd-total">
        <td>+ shared stylesheets · ${fmtCount(assets_.count)}</td>
        <td>${fmtBytes(assets_.bytes)}</td>
        <td colspan="7" class="vd-note">stored once by content hash, uncompressed, and shared by every match that used them</td>
      </tr>
      <tr class="vd-total">
        <td>On disk now · retained replays + shared stylesheets</td>
        <td>${fmtBytes(bytes + (Number(assets_.bytes) || 0))}</td>
        <td colspan="7" class="vd-note">
          ${fmtBytes(mean)} per match on average &mdash; keeping the newest ${keep}
          works out at roughly ${fmtBytes(mean * keep)} once that many have been played
        </td>
      </tr>`;
  }

  const rowFor = (record) =>
    replayRowHtml(
      record,
      PANEL.visualLabel(record, matches().find((x) => x.id === record.matchId) || null),
      SHARE_PANEL.isOpen(record.matchId)
    );

  function renderPanel() {
    const panel = $("#visualPanel");
    if (!panel) return;
    const sorted = visualRecords.slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    // An archive file holds no visual replays, so the panel would be lying.
    panel.hidden = readOnly() || !sorted.length;

    /* Say so, rather than rendering nothing at all. The markup for this has
     * been in the page from the start and nothing ever showed it, so with no
     * recordings the whole view was blank - no table, no message, nothing to
     * distinguish "you have none" from "this is broken". The Shared links view
     * next door has always written its own empty row; this is the same idea. */
    const empty = $("[data-empty='replays']");
    if (empty) empty.hidden = readOnly() || sorted.length > 0;

    if (panel.hidden) return;

    // Every record gets a row: retention is the store's job, and it never hands
    // back more than the retention setting allows.
    setHtml("#visualTable tbody", sorted.map(rowFor).join(""));
    setHtml("#visualTable tfoot", totalsHtml(sorted, visualAssets, keepMatches));
  }

  // ---- events this view owns ---------------------------------------------

  /* Two attributes, both drawn by this file - and `data-visual` also by the
   * Matches view's expanded row, which carries it precisely so that one click
   * lands here. Nothing else on the page listens for either, so the branches
   * below and the listeners around them cannot fight over a click. */
  function mount(deps) {
    matches = deps.matches;
    readOnly = deps.readOnly;
    render = deps.render;
    readReplay = deps.readReplay;

    document.addEventListener("click", (e) => {
      const visualBtn = e.target?.closest?.("[data-visual]");
      const visualId = visualBtn && visualBtn.dataset.visual;
      if (visualId) {
        const m = matches().find((x) => x.id === visualId) || { id: visualId };
        /* `data-at` is a moment the click named: a timestamped note in the
         * match's own row carries one, every other opener carries none. It
         * rides on the same attribute the modal already opens from rather than
         * a second one, so there is still exactly one path from a click to a
         * replay - and a note arrives with the drawer it came from open. */
        const at = visualBtn.dataset.at;
        const startAtMs = at === undefined ? undefined : Number(at) || 0;
        readReplay(visualId).then(
          (payload) => {
            if (!payload || !payload.events || !payload.events.length) {
              say(unreadableReason(payload), "error");
              return;
            }
            root.RATrackerVisualReplay.openModal(m, payload, {
              shareMoment: (request) => root.RATrackerShareMoment.shareMoment(request, m),
              // Null while an archive is open, which is what leaves that modal
              // with no drawer rather than one that cannot save.
              notes: NOTES.hooksFor(visualId),
              openNotes: startAtMs !== undefined,
              startAtMs,
            });
          },
          (err) => {
            // A storage fault, not an empty recording: say so, and leave the real
            // error somewhere a bug report can reach it.
            console.warn("[Rift Atlas] replay read failed:", err);
            say("The replay for this match could not be read: " + String((err && err.message) || err), "error");
          }
        );
        return;
      }

      const delReplay = e.target?.closest?.("[data-visualdel]");
      if (!delReplay) return;
      const matchId = delReplay.dataset.visualdel;
      // A recording being uploaded right now is the one thing that must not be
      // pulled out from under the pipeline reading it.
      if (SHARE_PIPELINE.busyWith() === matchId) {
        say("This replay is being shared right now. Wait for that to finish.", "error");
        return;
      }
      const record = visualRecords.find((r) => r.matchId === matchId);
      const size = record ? fmtBytes(record.compressedBytes) : null;
      const shared = SHARES_VIEW.list().some((r) => r && r.matchId === matchId);
      ask(deleteConfirm(size, shared)).then((ok) => {
        if (!ok) return;
        forgetVisual(matchId);
        SHARE_PANEL.close(matchId);
        // The Matches view keys its replay buttons off hasVisual(), so it has
        // to be told as well as the panel this row lives in.
        render();
        say("Recording deleted. The match is still here.", "success");
      });
    });
  }

  /**
   * What deleting a recording has to say before it happens.
   *
   * Deleting a RECORDING is not deleting a match, and the wording has to carry
   * that: the match record, its game log, its result and its card list all
   * survive, which is exactly what the retention setting already promises when
   * it drops the oldest replay.
   *
   * A shared replay gets a third paragraph, because the one thing this cannot
   * do is take back the encrypted copy on the endpoint - and clearing the local
   * record would only lose the key that opens it.
   */
  function deleteConfirm(size, shared) {
    return {
      title: "Delete this recording?",
      sub: size ? `Frees ${size}` : undefined,
      body:
        "<p>The match itself is kept &mdash; its record, its game log, its result and its card " +
        "list are all untouched. Only the video-like replay goes.</p>" +
        "<p>It cannot be recovered. A replay is never in an export or an archive, so there is " +
        "nothing to restore it from.</p>" +
        (shared
          ? "<p>You have shared this replay. <b>Deleting your copy does not delete the share</b> " +
            "&mdash; the encrypted copy on the endpoint is served until it expires, and clearing " +
            "it here would only lose the key that opens it.</p>"
          : ""),
      confirmLabel: "Delete recording",
      danger: true,
    };
  }

  root.RATrackerViewReplays = {
    ensureVisualIds,
    hasVisual,
    forgetVisual,
    forgetAllVisual,
    records,
    assets,
    keepCount,
    setKeepMatches,
    replayRowHtml,
    totalsHtml,
    deleteConfirm,
    renderPanel,
    mount,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerViewReplays;
}
