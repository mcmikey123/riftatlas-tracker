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

  const FIRST_POLL_MS = 5 * 1000;
  const POLL_MS = 3 * 60 * 1000;
  const PENDING_POLL_MS = 60 * 1000; // a replay is being prepared: come back sooner
  const PAGE_SIZE = 10;
  // Per poll. Each one is a full action log; the rest wait for the next poll.
  const MAX_DOWNLOADS = 3;
  /* Between downloads, so a backlog never lands all at once. It also runs
   * during a match - older games' replays expire while you play the next one -
   * and each download is a few milliseconds of main-thread work (the parse and
   * the hand-off to the worker), so spread out they cost the game nothing. */
  const DOWNLOAD_GAP_MS = 10 * 1000;
  /* The server sometimes takes a replay it lists as ready and answers nothing
   * at all - no headers - while the same request a little later is served at
   * once. So a download is cut off well past a slow normal one (~760 KB takes
   * a second or two) and tried again within the same poll; only after every
   * retry fails is it left to the next poll. */
  const DOWNLOAD_TIMEOUT_MS = 15 * 1000;
  const RETRY_DELAYS_MS = [5 * 1000, 15 * 1000];
  const INPUT_WAIT_MS = 30000;
  const INPUT_POLL_MS = 250;

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

  /* fetch() reports every network failure as the same "Failed to fetch" - the
   * browser keeps the real reason from scripts. So a failure is labelled with
   * what a script CAN see: which stage it died in, how long it took, and the
   * state of the page around it. A stuck request is cut off rather than left
   * pending, so it fails with a reason instead of not at all. */
  async function download(token, gameKey) {
    const started = Date.now();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), DOWNLOAD_TIMEOUT_MS);
    let stage = "request";
    let status = null;
    try {
      const res = await fetch(H.REPLAY_URL + encodeURIComponent(gameKey), {
        headers: { accept: H.REPLAY_ACCEPT, authorization: "Bearer " + token },
        credentials: "omit",
        signal: abort.signal,
      });
      status = res.status;
      if (!res.ok) throw new Error("replay " + res.status);
      stage = "body";
      const text = await res.text();
      stage = "parse";
      // A truncated body or an error reply must not be stored as a replay.
      if (!H.isReplay(JSON.parse(text))) throw new Error("replay: not a riftatlas-replay file");
      return text;
    } catch (err) {
      const why = abort.signal.aborted ? `timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s` : String(err && err.message);
      throw new Error(
        `${why} | stage=${stage} status=${status} after=${Date.now() - started}ms ` +
          `online=${navigator.onLine} visible=${document.visibilityState} ` +
          `board=${!!document.querySelector('[data-testid="game-state"]')}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async function downloadWithRetry(token, gameKey) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await download(token, gameKey);
      } catch (err) {
        const wait = RETRY_DELAYS_MS[attempt];
        if (wait == null) throw err;
        console.info(`[RA-Tracker] official replay attempt ${attempt + 1} failed, retrying in ${wait / 1000}s`, gameKey, err.message);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  /** One pass: list, download what is missing, store it. Resolves to the next delay. */
  async function syncOnce() {
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
    for (const [i, summary] of todo.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, DOWNLOAD_GAP_MS));
      try {
        const text = await downloadWithRetry(token, summary.gameKey);
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
    // A failed download is retried on the sooner schedule: the ones seen so far
    // were transient, and the server copy is on a clock.
    const more = all.length > todo.length || saved < todo.length;
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
        setTimeout(look, INPUT_POLL_MS);
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
  function start() {
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
