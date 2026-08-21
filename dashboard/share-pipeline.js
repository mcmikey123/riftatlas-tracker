/* Rift Atlas Stats Tracker - turning a replay into a link
 *
 * The upload itself: read the recording, re-strip its stylesheets, compress,
 * encrypt, PUT, read the object back, and write down the key. The panel it
 * paints into is share-panel.js; the wording and the state live there.
 *
 * The second click does not always upload. A live share for this match is
 * handed back instead - see `startRowShare` - because a second upload leaves a
 * second undeletable copy of the same replay on the endpoint for the same
 * seven days. The panel says when a link is reused and offers a forced upload
 * for someone who wants a full week rather than what is left of one.
 *
 * Building a share blocks the main thread for ~600 ms on the worst replay
 * measured - JSON.stringify 224 ms plus deflate 273 ms, with crypto at 3 ms -
 * and peaks near 380 MB. Every phase therefore paints before it begins, and
 * only one share may be in flight at a time.
 *
 * The pure parts - the size check, the failure taxonomy, the magic-byte check
 * and the record shape - live in share/share-ui-support.js and are tested.
 * What is left here is DOM, crypto and network, which by project convention
 * gets no unit tests and must instead stay small and obviously correct. The one
 * exception is `shareFailure`, which is a decision over an error and is tested.
 */
(function (root) {
  "use strict";

  // Loaded first by dashboard.html; the requires are for node. Everything else
  // this file uses - the crypto, the clipboard, the store, the repaint helper -
  // is reached through `window` at call time, because none of it is reachable
  // or needed outside a browser.
  const SHARE = root.RAShareUI || require("../share/share-ui-support.js");
  const HOSTS = root.RAShareHosts || require("../share/hosts.js");
  const CONFIG = root.RAShareConfig || require("../share/config.js");
  const CLAMP = root.RATrackerSettingsClamps || require("./settings-clamps.js");
  const PANEL = root.RATrackerSharePanel || require("./share-panel.js");

  // Whether the configured endpoint may be uploaded to, and why a stored
  // replay could not be played. Both are decidable from their argument alone,
  // so both live and are tested next to the rest of the taxonomy.
  const { endpointProblem, unreadableReason } = SHARE;

  let shareBusy = null; // matchId of the share currently running, or null
  // The promise that share settles with, so a second caller asking for the same
  // match waits on the share already running instead of being told nothing.
  let shareRunning = null;

  /** Which match is being uploaded right now, or null. */
  const busyWith = () => shareBusy;

  /** A failure the share flow raised itself, carrying what to show for it. */
  class ShareUiError extends Error {
    constructor(message, retry) {
      super(message);
      this.name = "ShareUiError";
      this.shareMessage = message;
      this.shareRetry = !!retry;
    }
  }

  /* A failure that came out of the upload call, and only out of the upload
   * call. share/share-ui-support.js reads a status off it and maps "no status"
   * to a transport failure, which is only true of a fetch that was actually
   * attempted: a local failure has no status either, and reporting one as
   * "couldn't reach the share endpoint" would offer a retry for something that
   * repeats identically. Wrapped rather than sniffed, so the distinction is
   * made where it is known rather than guessed from shape afterwards. */
  class ShareUploadError extends Error {
    constructor(cause) {
      super(String((cause && cause.message) || cause));
      this.name = "ShareUploadError";
      this.status = cause && cause.status;
      this.cause = cause;
    }
  }

  /* Let the browser paint the phase label before the phase begins. Shared with
   * the standalone viewer rather than reimplemented: waiting on a frame alone
   * never resolves in a backgrounded tab, which would park the pipeline with
   * shareBusy still held and every other match's Share button disabled. */
  const paintYield = () => window.RARepaint.repaint(window);

  const sha256Hex = async (text) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  // Reading a replay is the dashboard's, not this file's: the same reader opens
  // the replay modal, and two of them would be two IndexedDB connections to the
  // same store. Supplied by mount().
  let readReplay = null;
  // A full re-render, for the one branch below that changes what a row shows.
  let render = () => {};
  // The flags a share should carry for a match, or null - the match array is
  // the dashboard's too. Supplied by mount().
  let matchFlags = () => null;

  /* Read just enough of an object to recognise it: the four magic bytes. Used
   * both to verify a fresh upload and to re-check an old share from the shares
   * list, which is why it reports what happened rather than throwing.
   *
   * No Range header, deliberately. The Worker's /b/ route hands R2's whole body
   * back - `BUCKET.get(id)` takes no range - so a range request would be ignored
   * and answered 200 with the full object anyway, while risking a CORS preflight
   * against a route that answers OPTIONS with 405. Cancelling after the first
   * chunk is what actually keeps this cheap: the head of a 3.5 MB share costs
   * one chunk, not 3.5 MB, and it is the same read the upload verification has
   * been doing against the deployed Worker all along.
   *
   *   reached  the endpoint answered at all
   *   status   its HTTP status, 0 when the fetch itself failed
   *   bytes    the first few bytes of the body, empty unless it answered 2xx */
  async function fetchObjectHead(endpoint, objectId) {
    const base = HOSTS.normaliseEndpoint(endpoint);
    // Encoded like the viewer's own download does. Ids that reach here are the
    // validated 22-char shape, so this changes nothing today - it is what keeps
    // that still being true if one ever arrives from somewhere else.
    const url = `${base}/b/${encodeURIComponent(objectId)}`;
    const empty = new Uint8Array(0);
    let res;
    try {
      res = await fetch(url, { cache: "no-store" });
    } catch (_) {
      return { reached: false, status: 0, bytes: empty };
    }
    if (!res.ok || !res.body) {
      if (res.body) res.body.cancel().catch(() => {});
      return { reached: true, status: res.status, bytes: empty };
    }

    const reader = res.body.getReader();
    let head = empty;
    try {
      while (head.length < 4) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || !value.length) continue;
        const merged = new Uint8Array(head.length + value.length);
        merged.set(head);
        merged.set(value, head.length);
        head = merged;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return { reached: true, status: res.status, bytes: head };
  }

  /* Never show a link that has not been read back. This is the check that would
   * have caught the host found during research which answered a curl probe with
   * the bytes and a browser with an HTML interstitial. */
  async function verifyObject(endpoint, objectId) {
    const head = await fetchObjectHead(endpoint, objectId);
    if (!SHARE.hasShareMagic(head.bytes)) throw new ShareUiError(SHARE.MESSAGES.unverified, true);
  }

  const setShare = (matchId, patch) => PANEL.setShare(matchId, patch);

  /* Enters already painted as "preparing" by beginShare, which is the caller
   * that owns the busy flag; painting it a second time here would run the whole
   * panel through innerHTML twice for one state. */
  async function runShare(matchId, endpoint) {
    await paintYield();

    let replay;
    try {
      replay = await readReplay(matchId);
    } catch (err) {
      console.warn("[Rift Atlas] replay read failed:", err);
      throw new ShareUiError(SHARE.MESSAGES.unreadable, false);
    }
    if (!replay || !replay.events || !replay.events.length) {
      throw new ShareUiError(unreadableReason(replay), false);
    }

    /* get() hands back the stylesheets rehydrated inline into every one of the
     * keyframe. Re-stripping them with the same pure function storage uses
     * costs one pass and takes the deflated frame from 5.95 MB to 3.48 MB on the
     * worst replay measured. The viewer runs rehydrateCssAssets after decrypting,
     * which is the exact inverse. */
    setShare(matchId, { phase: "stripping" });
    await paintYield();
    const { events, assets } = await window.extractCssAssets(replay.events, { hash: sha256Hex });

    setShare(matchId, { phase: "encrypting" });
    await paintYield();
    const key = await window.RAShare.generateKey({});
    /* Flags ride along in the meta: they are part of what the sharer is
     * pointing at, and the share viewer draws them read-only. Copied at build
     * time from the match record, which is where they live. */
    const flags = matchFlags(matchId);
    const frame = await window.RAShare.buildSharePayload(
      // assets arrives as a Map; JSON needs a plain object.
      {
        meta: flags ? Object.assign({}, replay.meta, { flags }) : replay.meta,
        events,
        assets: Object.fromEntries(assets),
      },
      key,
      {}
    );

    /* Measured on the frame that will actually be sent, never predicted from
     * meta.compressedBytes - that is the store's per-chunk total and differs
     * (3,760,696 against 3,644,834 on the measured replay). */
    const size = SHARE.checkPayloadSize(frame.byteLength, SHARE.MAX_UPLOAD_BYTES);
    if (!size.ok) throw new ShareUiError(size.message, false);

    setShare(matchId, { phase: "uploading" });
    await paintYield();
    let objectId;
    try {
      objectId = await HOSTS.hostFor("w").upload(frame, {
        endpoint,
        token: CONFIG.SHARE_TOKEN,
        fetch: (url, init) => fetch(url, init),
      });
    } catch (err) {
      throw new ShareUploadError(err);
    }

    setShare(matchId, { phase: "verifying" });
    await paintYield();
    await verifyObject(endpoint, objectId);

    const keyBytes = await window.RAShare.exportKey(key, {});
    const record = SHARE.shareRecord({
      matchId,
      objectId,
      key: HOSTS.toBase64Url(keyBytes),
      endpoint: HOSTS.normaliseEndpoint(endpoint),
      createdAt: Date.now(),
    });
    await rememberShare(record);
    // The record comes back as well as the link: the replay modal rebuilds its
    // own link from it with a timestamp attached, rather than splicing one onto
    // the end of a string somebody else assembled.
    return {
      link: HOSTS.buildLink({ endpoint, objectId, keyBytes }),
      createdAt: record.createdAt,
      record,
    };
  }

  /* chrome.storage.local key "shares": an array of share records in creation
   * order, whose shape share/share-ui-support.js documents and validates. The
   * key is stored because it exists nowhere else - the endpoint never sees it,
   * and without it a link cannot be rebuilt, only lost. The shares list reads
   * this. A write that fails must not lose the link the user is looking at, so
   * the flow carries on either way.
   *
   * Every write drops the records whose objects are certainly gone. Nothing
   * else ever would: there is no expiry job and no server to run one, so
   * without this a browser accumulates every key it has ever generated, long
   * after the only thing they could decrypt stopped existing.
   *
   * KNOWN RACE: get-then-set is not atomic, and chrome.storage.local is shared
   * across every dashboard tab. Two tabs completing a share at the same moment
   * can have the second write back a list read before the first landed, losing
   * a record - and a lost record takes a key that exists nowhere else. Sharing
   * twice within the same few milliseconds from two tabs is the only way to hit
   * it, so it is left as it stands; closing it properly needs the writes
   * serialised through the service worker, which is more machinery than this
   * feature justifies. `forgetShare` in shares-view.js writes the same way and
   * has the same race. */
  function rememberShare(record) {
    return new Promise((resolve) =>
      chrome.storage.local.get({ shares: [] }, (data) => {
        const shares = SHARE.pruneShares(data.shares, Date.now());
        shares.push(record);
        window.RATrackerStorage.writeShares(shares, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      })
    );
  }

  /* Resolves with what runShare produced, or null if nothing was uploaded -
   * refused or failed. Never rejects: every failure has already been turned into
   * a message in the panel by the time this settles, and a second caller
   * re-reporting it would say the same thing twice. The replay modal awaits it;
   * the row's own button ignores it.
   *
   * Asking for a share of THIS match while that same share is in flight hands
   * back the promise it is already running on, rather than a null the caller
   * would read as a failure: the modal's panel would paint "could not be
   * prepared" over an upload that was seconds from succeeding. That is reachable
   * by starting a share from the row's panel and then opening the modal. */
  function beginShare(matchId) {
    // Every message this raises is shown inside the panel, so the panel has to
    // be open for any of them to be read. It always is - the button that gets
    // here lives in it - but nothing else guarantees that.
    PANEL.open(matchId);
    if (shareBusy) {
      // The `||` is for the one path where shareBusy is set and the promise is
      // not: a throw between the two assignments below. Unreachable today, and a
      // caller crashing on `null.then` is not the way to find out otherwise.
      if (shareBusy === matchId) return shareRunning || Promise.resolve(null);
      setShare(matchId, {
        phase: "idle",
        error: "Another replay is being shared right now. Wait for that one to finish.",
        retry: true,
      });
      return Promise.resolve(null);
    }
    const endpoint = shareEndpoint;
    const problem = endpointProblem(endpoint);
    if (problem) {
      setShare(matchId, { phase: "idle", error: problem, retry: true });
      return Promise.resolve(null);
    }
    shareBusy = matchId;
    // `reuse` goes with the link it described: what follows is an upload, and a
    // stale reuse notice under a freshly uploaded link would say the opposite of
    // what happened. Cleared here rather than on completion because every share
    // passes through this phase, including a failing one.
    setShare(matchId, { phase: "preparing", link: null, reuse: null, error: null, retry: false });
    shareRunning = runShare(matchId, endpoint)
      .then(
        (made) => {
          setShare(matchId, {
            phase: "done",
            link: made.link,
            createdAt: made.createdAt,
            error: null,
          });
          return made;
        },
        (err) => {
          console.warn("[RA-Tracker] sharing failed:", err);
          setShare(matchId, Object.assign({ phase: "idle", link: null }, shareFailure(err)));
          return null;
        }
      )
      // finally, not then: a throw inside either settle handler above would
      // otherwise leave shareBusy set for good, disabling sharing for every
      // match until the page is reloaded.
      .finally(() => {
        shareBusy = null;
        shareRunning = null;
      });
    return shareRunning;
  }

  /* The match row's "Create share link", and its "Create a new link anyway".
   *
   * The reuse decision lives here rather than inside `beginShare` because
   * `beginShare` is also what the replay modal's moment path calls, and that
   * path has already made the decision itself - it has a timestamp to splice
   * into the link and a panel of its own to paint into, neither of which this
   * side knows about. A check inside `beginShare` would run second, on a
   * question already answered, and would have to be told to keep quiet for one
   * of its two callers. One decision per button, taken by the button.
   *
   * The storage read happens on the click, not when the panel was opened, which
   * is what makes this the check at the moment of upload: the panel can sit open
   * for as long as it likes, and a share landing from the modal in the meantime
   * is found here. `forceNew` is the one case that skips the lookup, because
   * finding a share is exactly what the presser is refusing.
   *
   * Consent is not asked again: the disclosure is rendered above this button
   * every time the panel is painted, so it is on screen for both the reuse and
   * the forced upload. */
  async function startRowShare(matchId, options) {
    const stored = await window.RATrackerStorage.readShares();
    const plan = SHARE.planShare(stored, matchId, Date.now(), options);
    if (plan.action === "reuse") {
      // No upload and no record: a second record for the same object would be a
      // duplicate row in the shares panel claiming to be a second share.
      setShare(matchId, {
        phase: "idle",
        link: PANEL.linkFor(plan.record),
        createdAt: plan.record.createdAt,
        reuse: plan.record,
        error: null,
        retry: false,
      });
      return;
    }
    beginShare(matchId);
  }

  /* What to show for a failed share. Three sources, and only the middle one may
   * be read as a network or endpoint problem:
   *
   *   ShareUiError      raised here, already carrying its own message
   *   ShareUploadError  came out of the PUT, so the status mapping applies
   *   anything else     a local failure - the CSS re-strip, the crypto, a
   *                     script tag that did not load - which nothing about the
   *                     endpoint explains and a retry would repeat exactly */
  function shareFailure(err) {
    if (err instanceof ShareUiError) return { error: err.shareMessage, retry: err.shareRetry };
    if (err instanceof ShareUploadError) {
      const shown = SHARE.describeUploadFailure(err);
      return { error: shown.message, retry: shown.retry };
    }
    return { error: SHARE.MESSAGES.unprepared, retry: false };
  }

  /* share/clipboard.js rather than a local copy: the standalone viewer hands
   * over links from a button too, and the two surfaces have drifted on smaller
   * things than this. Handing it the field selects it either way, so a blocked
   * clipboard leaves the link ready for a manual copy rather than leaving the
   * user with nothing. */
  function copyShareLink(matchId, button) {
    const s = PANEL.stateOf(matchId);
    if (!s.link) return;
    window.RAClipboard.copyToButton(s.link, button, {
      field: document.querySelector(`[data-sharelink="${CSS.escape(matchId)}"]`),
    });
  }

  // ---- the endpoint uploaded to ------------------------------------------

  let shareEndpoint = CONFIG.DEFAULT_SHARE_ENDPOINT;

  const cleanEndpoint = (value) => CLAMP.cleanEndpoint(value, CONFIG.DEFAULT_SHARE_ENDPOINT);

  /* There is no Settings field for this. The stored value is still honoured, so
   * a self-hoster can point the extension at their own instance without editing
   * code — see share/worker/README.md — but it is set through storage rather
   * than through a box that every other user would have to scroll past and
   * wonder about. */
  function loadEndpoint() {
    window.RATrackerStorage.getSettings((s) => {
      shareEndpoint = cleanEndpoint(s.shareEndpoint);
    });
  }

  // ---- events this file owns ---------------------------------------------

  /**
   * `readReplay` reads a stored recording; `render` redraws the page.
   *
   * The listener is registered here rather than at load, so its position among
   * the page's other document-level click listeners is the caller's to choose.
   * It must stay ahead of view-matches.js's `[data-share]` branch, which
   * expands a collapsed row so that the panel this toggles open has somewhere
   * to be drawn.
   */
  function mount(deps) {
    readReplay = deps.readReplay;
    render = deps.render;
    if (deps.matchFlags) matchFlags = deps.matchFlags;

    document.addEventListener("click", (e) => {
      // The panel is toggled in place rather than through a render, so opening
      // it disturbs nothing else in the row - and a share already running
      // cannot be closed out from under itself.
      const shareBtn = e.target?.closest?.("[data-share]");
      if (shareBtn) {
        const shareId = shareBtn.dataset.share;
        // A share already running must not be closed out from under itself.
        if (shareBusy === shareId) return;
        PANEL.toggle(shareId);
        /* Re-render rather than poking one box. The panel can be asked for from
         * the expanded match row, from that row's ⋯ menu while it is collapsed,
         * or from the Replays list - and only a render puts it where it was
         * asked for. Nothing in flight is lost: the share state lives outside
         * the DOM precisely so a rebuild cannot drop it. */
        render();
        return;
      }
      const shareGoId = e.target?.dataset?.sharego;
      if (shareGoId) {
        // Disabled synchronously: the shares read below is asynchronous, and the
        // panel does not repaint until it comes back. Every outcome repaints from
        // the share state, which is what puts the button back or replaces it.
        e.target.disabled = true;
        startRowShare(shareGoId, { forceNew: false });
        return;
      }
      const shareNewId = e.target?.dataset?.sharenew;
      if (shareNewId) {
        e.target.disabled = true;
        startRowShare(shareNewId, { forceNew: true });
        return;
      }
      const shareCopyId = e.target?.dataset?.sharecopy;
      if (shareCopyId) {
        copyShareLink(shareCopyId, e.target);
      }
    });
  }

  root.RATrackerSharePipeline = {
    ShareUiError,
    ShareUploadError,
    shareFailure,
    fetchObjectHead,
    verifyObject,
    rememberShare,
    beginShare,
    startRowShare,
    busyWith,
    loadEndpoint,
    // The endpoint uploads go to, for the one other uploader (the series
    // share) - which must never read the setting a second time and drift.
    endpoint: () => shareEndpoint,
    mount,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerSharePipeline;
}
