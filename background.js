/* The toolbar icon opens popup/popup.html. There is no action.onClicked
 * listener here because Chrome does not fire that event at all once an action
 * has a default_popup - the popup's own "Open dashboard" button is what opens
 * the dashboard tab now. */

/* Visual replay storage.
 *
 * MV3 service workers run as classic scripts, so the store and its dependencies
 * arrive via importScripts and register themselves on globalThis. The platform
 * pieces the store leaves injectable - compression and hashing - are supplied
 * here, which is also what keeps `store/replay-store.js` testable under node. */
importScripts("store/idb.js", "store/css-assets.js", "store/replay-store.js");

const VISUAL_PREFIX = "ra:visual:";
/* How many matches keep a visual track. This is the *primary* storage control -
 * recordings are never degraded to fit a size, so total disk use is retention
 * times the cost of a match - which is why it is a setting the owner turns and
 * is re-read from storage at every gc rather than captured at worker start. */
const DEFAULT_KEEP_MATCHES = 25;
const KEEP_MIN = 1;
const KEEP_MAX = 500;

// Retention must never fail a match's stop, so an unreadable setting falls back
// to the default rather than throwing or skipping the gc entirely.
function keepNewest() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ settings: {} }, (data) => {
        const n = Math.round(Number(((data && data.settings) || {}).visualReplayKeepMatches));
        resolve(Number.isFinite(n) ? Math.min(KEEP_MAX, Math.max(KEEP_MIN, n)) : DEFAULT_KEEP_MATCHES);
      });
    } catch (_) {
      resolve(DEFAULT_KEEP_MATCHES);
    }
  });
}

const toBytes = (data) => (data instanceof Uint8Array ? data : new Uint8Array(data));

// deflate-raw: no gzip/zlib framing, which is pure overhead for bytes that
// never leave IndexedDB.
async function through(data, stream) {
  const piped = new Response(toBytes(data)).body.pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

const compress = (data) => through(data, new CompressionStream("deflate-raw"));
const decompress = (data) => through(data, new DecompressionStream("deflate-raw"));

async function hash(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const replayStore = self.RATrackerReplayStore.createReplayStore({
  idb: self.RATrackerIdb,
  compress,
  decompress,
  hash,
});

/* Stylesheets are content-addressed, so their cost belongs to the whole store
 * rather than to any one match: this is what the diagnostics panel reports as
 * the shared footprint. Diagnostics must never fail a listing, so it degrades
 * to zero rather than throwing. */
async function assetFootprint() {
  try {
    const assets = (await self.RATrackerIdb.getAll("assets")) || [];
    let bytes = 0;
    for (const asset of assets) bytes += ((asset && asset.text) || "").length;
    return { count: assets.length, bytes };
  } catch (_) {
    return { count: 0, bytes: 0 };
  }
}

async function handleVisual(msg) {
  switch (msg.type) {
    case "ra:visual:start":
      await replayStore.start(msg.matchId, msg.meta);
      return { ok: true };
    case "ra:visual:events": {
      const result = await replayStore.append(msg.matchId, msg.events, msg.rawBytes);
      return { ok: true, ...result };
    }
    case "ra:visual:stop":
      await replayStore.stop(msg.matchId, {
        reason: msg.reason,
        truncatedAtTurn: msg.truncatedAtTurn,
        error: msg.error,
        stats: msg.stats,
      });
      // Retention runs on the way out of every match, and its own failure is
      // never the stop's: the match is already safely closed by this point.
      try {
        await replayStore.gc(await keepNewest());
      } catch (e) {
        console.warn("[Rift Atlas] visual replay retention failed:", e);
      }
      return { ok: true };
    /* No "ra:visual:get". Reads happen in the dashboard, against the same
     * IndexedDB, because a whole replay does not reliably fit through a message:
     * get() rehydrates every stylesheet into every keyframe, and a real 3.72 MB
     * recording came out past the 64 MiB ceiling and would not open at all.
     *
     * The snapshot cadence has since cut keyframe counts by roughly an order of
     * magnitude, so that specific recording would fit today - but the ceiling is
     * fixed while match length is not, and nothing here would warn before it was
     * crossed again. The store still exposes get(); this side is no longer one
     * of its callers. */
    case "ra:visual:list":
      return { ok: true, replays: await replayStore.list(), assets: await assetFootprint() };
    // Deleting a match must take its DOM recording with it: the visual track
    // holds the opponent's name and the in-game chat, and nothing else in the
    // extension can reach this database once the match record is gone.
    case "ra:visual:delete":
      await self.RATrackerIdb.clearMatch(msg.matchId);
      return { ok: true };
    case "ra:visual:clear":
      await self.RATrackerIdb.clearAll();
      return { ok: true };
    default:
      return { ok: false, error: "unknown message " + msg.type };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Anything that isn't ours is left to the other listeners untouched.
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith(VISUAL_PREFIX)) return;
  // A storage failure must never reject into the content script: the recording
  // stops, and the match record, its game log, its result and its card list all
  // carry on to the end of the match regardless.
  //
  // .catch, not .then's second argument: that argument cannot see a throw from
  // sendResponse itself, and sending an oversized reply throws exactly there.
  // The sender was left with `undefined` and no reason at all, which is how a
  // payload too large to transport came to look like an unreadable recording.
  handleVisual(msg)
    .then(sendResponse)
    .catch((e) => {
      console.warn("[Rift Atlas] visual message failed:", msg.type, e);
      try {
        sendResponse({ ok: false, error: String(e) });
      } catch (_) {
        // The channel closed under us, or the failure reply is itself
        // untransportable. There is nothing further this side can say.
      }
    });
  return true; // reply lands asynchronously
});
