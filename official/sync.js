/* Rift Atlas Stats Tracker - fetching official replays while they exist
 *
 * The site's replay of a game becomes downloadable a little after it ends and
 * is deleted server-side a few hours later. So while a play.riftatlas.com tab
 * is open, this polls the game history and downloads every replay that is
 * ready and not yet on disk; background.js stores it. A game whose replay is
 * still being prepared brings the next poll forward.
 *
 * The requests go out from this content script, not the service worker:
 * content-script fetches carry the page's origin, which the site's own API
 * already accepts, so no new host permission is needed - and the token they
 * need only exists in the page (official/token-bridge.js).
 *
 * The other half is the way back: on the site's replay viewer, opened by the
 * dashboard with a game key in the fragment, the stored JSON is handed to the
 * viewer's own file input as if the player had picked the file.
 */
(function (root) {
  "use strict";

  const H = root.RATOfficialHistory || require("./history.js");

  const SOURCE = "rat-official";
  const FIRST_POLL_MS = 15 * 1000;
  const POLL_MS = 3 * 60 * 1000;
  const PENDING_POLL_MS = 60 * 1000; // a replay is being prepared: come back sooner
  const BUSY_POLL_MS = 60 * 1000; // a match is live: nothing new can have finished
  const PAGE_SIZE = 10;
  // Per poll. Each one is a full action log; the rest wait for the next poll.
  const MAX_DOWNLOADS = 3;
  const TOKEN_TIMEOUT_MS = 15000;
  const INPUT_WAIT_MS = 30000;

  let busy = () => false;
  let timer = null;
  let running = false;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (reply) => {
          void chrome.runtime.lastError;
          resolve(reply || null);
        });
      } catch (_) {
        resolve(null); // extension reloaded under the page
      }
    });
  }

  function requestToken() {
    return new Promise((resolve) => {
      const nonce = Math.random().toString(36).slice(2);
      const done = (token) => {
        window.removeEventListener("message", onReply);
        clearTimeout(t);
        resolve(token);
      };
      const onReply = (e) => {
        const d = e.data;
        if (e.source !== window || !d || d.source !== SOURCE || d.kind !== "token" || d.nonce !== nonce) return;
        done(H.tokenUsable(d.token, Date.now()) ? d.token : null);
      };
      const t = setTimeout(() => done(null), TOKEN_TIMEOUT_MS);
      window.addEventListener("message", onReply);
      window.postMessage({ source: SOURCE, kind: "token-request", nonce }, location.origin);
    });
  }

  async function listRecent(token) {
    const res = await fetch(H.LIST_URL, {
      method: "POST",
      // text/plain, as the site sends it: a simple request, no preflight.
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ args: { paginationOpts: { numItems: PAGE_SIZE, cursor: null } }, token }),
      credentials: "omit",
    });
    if (!res.ok) throw new Error("history " + res.status);
    return H.parsePage(await res.json());
  }

  async function download(token, gameKey) {
    const res = await fetch(H.REPLAY_URL + encodeURIComponent(gameKey), {
      headers: { accept: H.REPLAY_ACCEPT, authorization: "Bearer " + token },
      credentials: "omit",
    });
    if (!res.ok) throw new Error("replay " + res.status);
    const text = await res.text();
    // A truncated body or an error reply must not be stored as a replay.
    if (!H.isReplay(JSON.parse(text))) throw new Error("replay: not a riftatlas-replay file");
    return text;
  }

  /** One pass: list, download what is missing, store it. Resolves to the next delay. */
  async function syncOnce() {
    if (busy()) return BUSY_POLL_MS;
    const token = await requestToken();
    if (!token) return POLL_MS; // signed out, or Clerk not reachable: try again later
    const summaries = await listRecent(token);
    const stored = await send({ type: "ra:official:keys" });
    if (!stored || !stored.ok) return POLL_MS;
    const todo = H.wanted(summaries, stored.keys, Date.now()).slice(0, MAX_DOWNLOADS);
    for (const summary of todo) {
      try {
        const text = await download(token, summary.gameKey);
        await send({ type: "ra:official:put", summary, text });
        console.info("[RA-Tracker] official replay saved", summary.gameKey);
      } catch (err) {
        console.warn("[RA-Tracker] official replay download failed", summary.gameKey, err);
      }
    }
    const more = H.wanted(summaries, stored.keys, Date.now()).length > todo.length;
    return more || H.pending(summaries, Date.now()) ? PENDING_POLL_MS : POLL_MS;
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (running) return;
      running = true;
      let next = POLL_MS;
      try {
        next = await syncOnce();
      } catch (err) {
        console.warn("[RA-Tracker] official history sync failed", err);
      } finally {
        running = false;
      }
      schedule(next);
    }, ms);
  }

  // ---- the viewer --------------------------------------------------------

  function waitForFileInput() {
    return new Promise((resolve) => {
      const until = Date.now() + INPUT_WAIT_MS;
      (function look() {
        const input = document.querySelector('input[type="file"]');
        if (input) return resolve(input);
        if (Date.now() > until) return resolve(null);
        setTimeout(look, 250);
      })();
    });
  }

  /* Hand the stored replay to the site's own file input. A DataTransfer is the
   * one way to set `files` from script, and the change event is what the
   * site's handler listens for - the same two things a real pick produces. */
  async function openFromHash() {
    const gameKey = H.viewerKeyFrom(location.hash);
    if (!gameKey) return;
    const reply = await send({ type: "ra:official:get", gameKey });
    if (!reply || !reply.ok || !reply.text) {
      console.warn("[RA-Tracker] official replay not stored", gameKey);
      return;
    }
    const input = await waitForFileInput();
    if (!input) {
      console.warn("[RA-Tracker] the replay viewer's file input never appeared");
      return;
    }
    const dt = new DataTransfer();
    dt.items.add(new File([reply.text], H.fileName(gameKey), { type: "application/json" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Start polling, or on the viewer page load the replay the fragment names. */
  function start(opts) {
    busy = (opts && opts.busy) || busy;
    if (H.isViewerPage(location)) {
      openFromHash().catch((err) => console.warn("[RA-Tracker] official replay open failed", err));
      return;
    }
    schedule(FIRST_POLL_MS);
  }

  const isViewerPage = () => H.isViewerPage(location);

  root.RATOfficialSync = { start, isViewerPage };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATOfficialSync;
}
