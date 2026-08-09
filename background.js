// Opens the dashboard when the toolbar icon is clicked.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
});

/* Visual replay storage.
 *
 * MV3 service workers run as classic scripts, so the store and its dependencies
 * arrive via importScripts and register themselves on globalThis. The platform
 * pieces the store leaves injectable - compression and hashing - are supplied
 * here, which is also what keeps `store/replay-store.js` testable under node. */
importScripts("store/idb.js", "store/css-assets.js", "store/replay-store.js");

const VISUAL_PREFIX = "ra:visual:";
// How many matches keep a visual track. Hardcoded on purpose: retention is not
// a setting, and the diagnostics panel shows the same 25.
const KEEP_NEWEST = 25;

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
        await replayStore.gc(KEEP_NEWEST);
      } catch (e) {
        console.warn("[Rift Atlas] visual replay retention failed:", e);
      }
      return { ok: true };
    case "ra:visual:get":
      return { ok: true, replay: await replayStore.get(msg.matchId) };
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
  // A storage failure must never reject into the content script: the visual
  // track degrades, the structured tracker carries on.
  handleVisual(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
  return true; // reply lands asynchronously
});
