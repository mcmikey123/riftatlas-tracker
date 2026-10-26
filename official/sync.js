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
 * already accepts, so no new host permission is needed. The token comes the
 * way the site gets its own - a POST to its auth server, which the auth
 * cookie answers - and lives only as long as one poll.
 *
 * The other half is the way back: on the site's replay viewer, opened by the
 * dashboard with a game key in the fragment, the stored JSON is handed to the
 * viewer's own file input as if the player had picked the file.
 */
(function (root) {
  "use strict";

  const H = root.RATOfficialHistory || require("./history.js");

  const FIRST_POLL_MS = 15 * 1000;
  const POLL_MS = 3 * 60 * 1000;
  const PENDING_POLL_MS = 60 * 1000; // a replay is being prepared: come back sooner
  const BUSY_POLL_MS = 60 * 1000; // a match is live: nothing new can have finished
  const PAGE_SIZE = 10;
  // Per poll. Each one is a full action log; the rest wait for the next poll.
  const MAX_DOWNLOADS = 3;
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

  async function requestToken() {
    try {
      const res = await fetch(H.TOKEN_URL, { method: "POST", credentials: "include" });
      if (!res.ok) return null; // signed out
      const body = await res.json();
      return body && H.tokenUsable(body.token, Date.now()) ? body.token : null;
    } catch (_) {
      return null;
    }
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
    if (!token) {
      // Signed out, or the auth server unreachable: try again later.
      console.info("[RA-Tracker] official replays: no session token");
      return POLL_MS;
    }
    const summaries = await listRecent(token);
    const stored = await send({ type: "ra:official:keys" });
    if (!stored || !stored.ok) {
      console.warn("[RA-Tracker] official replays: storage unreachable", stored && stored.error);
      return POLL_MS;
    }
    const all = H.wanted(summaries, stored.keys, Date.now());
    const todo = all.slice(0, MAX_DOWNLOADS);
    let saved = 0;
    for (const summary of todo) {
      try {
        const text = await download(token, summary.gameKey);
        const reply = await send({ type: "ra:official:put", summary, text });
        if (!reply || !reply.ok) throw new Error("not stored: " + ((reply && reply.error) || "no reply"));
        saved++;
        console.info("[RA-Tracker] official replay saved", summary.gameKey);
      } catch (err) {
        console.warn("[RA-Tracker] official replay download failed", summary.gameKey, err);
      }
    }
    // One line per poll, so a quiet console still says how far the sync got.
    console.info(
      `[RA-Tracker] official replays: ${summaries.length} listed, ${all.length} to fetch, ${saved} saved`
    );
    const more = all.length > todo.length;
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
