/* Rift Atlas Stats Tracker - the session token, from the page's own world
 *
 * The game history and the replay downloads are authenticated with the same
 * short-lived Clerk token the site sends itself. Clerk lives on the page's
 * `window`, which an isolated content script cannot see, so this one file runs
 * in the MAIN world (see manifest.json) and does exactly one thing: answer a
 * token request posted by official/sync.js with whatever Clerk hands back.
 *
 * It reads nothing else and changes nothing on the page. The token it answers
 * with is the page's own, already readable by every script on it.
 */
(() => {
  "use strict";

  const SOURCE = "rat-official";
  // The site's Clerk JWT template: the token it sends carries aud "convex".
  const TEMPLATE = "convex";
  const CLERK_WAIT_MS = 10000;

  async function clerkSession() {
    const until = Date.now() + CLERK_WAIT_MS;
    while (Date.now() < until) {
      const clerk = window.Clerk;
      if (clerk && clerk.loaded && clerk.session) return clerk.session;
      if (clerk && clerk.loaded && !clerk.session) return null; // signed out
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== SOURCE || d.kind !== "token-request") return;
    let token = null;
    try {
      const session = await clerkSession();
      token = session ? await session.getToken({ template: TEMPLATE }) : null;
    } catch (_) {
      token = null;
    }
    window.postMessage({ source: SOURCE, kind: "token", nonce: d.nonce, token: token || null }, location.origin);
  });
})();
