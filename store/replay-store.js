/* Rift Atlas Stats Tracker - batching, compression and retention for visual replays.
 *
 * The open chunk is rewritten in place on every append, so a service worker
 * that dies mid-match leaves a readable replay behind rather than a hole. It
 * closes and the next seq opens when the incoming batch would cross
 * BATCH_MAX_RAW, or when the open chunk is older than BATCH_MAX_MS. All I/O
 * goes through the injected `idb`, so this is testable against plain Maps. */
(function (root) {
  "use strict";

  const { extractCssAssets, rehydrateCssAssets } =
    typeof require === "function" ? require("./css-assets.js") : root;

  const BATCH_MAX_RAW = 256 * 1024;
  const BATCH_MAX_MS = 5000;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // The reasons the recorder raises itself when a match outruns the capture.
  // They must be listed here rather than inferred from `truncatedAtTurn`: a kill
  // switch that latches before the first turn mark leaves that null, and the
  // viewer's truncation banner is the only explanation the replay ever gets.
  const TRUNCATING_REASONS = ["budget", "perf-kill", "restart"];

  function stateFor(reason, truncatedAtTurn) {
    if (reason === "end") return "complete";
    if (reason === "error") return "error";
    if (TRUNCATING_REASONS.includes(reason) || truncatedAtTurn !== null) return "truncated";
    return "stopped";
  }

  // Every chunk for one match. Undefined where IDBKeyRange is absent (node
  // tests); callers filter by matchId regardless.
  function chunkQuery(matchId) {
    if (typeof IDBKeyRange === "undefined") return undefined;
    return IDBKeyRange.bound([matchId, -Infinity], [matchId, Infinity]);
  }

  // `eventCount` doubles as the new chunk's firstEventIdx: it is exactly how
  // many events the closed chunks before it already hold.
  function newSession(seq, eventCount, closedBytes, rawBytes, cssRefs) {
    return {
      seq, events: [], firstEventIdx: eventCount, eventCount,
      chunkRaw: 0, chunkBytes: 0, openedAt: Date.now(),
      closedBytes, rawBytes, cssRefs,
    };
  }

  function createReplayStore(deps) {
    const { idb, compress, decompress, hash } = deps;
    const sessions = new Map();

    /* One promise chain per match, so every write for a match runs alone.
     *
     * The recorder flushes from two independent triggers (a timer and a size
     * threshold) without awaiting the previous reply, and a full snapshot
     * routinely crosses the size threshold - so overlapping calls are normal.
     * Un-serialized they corrupt the delta chain: two appends sharing a session
     * write the same composite `chunks` key and the loser's events vanish while
     * `eventCount` still counts them, skewing every later `firstEventIdx`. The
     * same read-modify-write race lets a `stop` revert the final append's
     * `cssRefs`, which strips the last keyframe of its styles. Both run through
     * here, so neither can interleave with the other. */
    const tails = new Map();

    function enqueue(matchId, fn) {
      const next = (tails.get(matchId) || Promise.resolve()).then(fn, fn);
      // The tail must never reject, or one failed write would poison the queue.
      const tail = next.catch(() => {});
      tails.set(matchId, tail);
      // Drop the entry once the queue drains, so matches don't accumulate here.
      tail.then(() => { if (tails.get(matchId) === tail) tails.delete(matchId); });
      return next;
    }

    // Rebuilds in-memory batch state from the stored record after a service
    // worker restart. The pre-restart chunk is left closed as it was.
    async function session(matchId) {
      const live = sessions.get(matchId);
      if (live) return live;

      const record = await idb.get("replays", matchId);
      if (!record) throw new Error("ra-visual: append before start for " + matchId);

      const restored = newSession(
        record.chunkCount || 0,
        (record.stats && record.stats.eventCount) || 0,
        record.compressedBytes || 0,
        record.rawBytes || 0,
        new Set(record.cssRefs || [])
      );
      sessions.set(matchId, restored);
      return restored;
    }

    // `changes` may be a function of the stored record, for the patches that
    // have to merge into what is already there rather than replace it.
    async function patchRecord(matchId, changes) {
      const record = await idb.get("replays", matchId);
      if (!record) return null;
      const next = Object.assign({}, record, typeof changes === "function" ? changes(record) : changes);
      await idb.put("replays", next);
      return next;
    }

    async function start(matchId, meta) {
      const m = meta || {};
      sessions.set(matchId, newSession(0, 0, 0, 0, new Set()));
      await idb.put("replays", {
        matchId,
        startedAt: m.startedAt || Date.now(),
        endedAt: null,
        viewport: m.viewport || null,
        href: m.href || null,
        cssRefs: [],
        chunkCount: 0,
        compressedBytes: 0,
        rawBytes: 0,
        state: "recording",
        truncatedAtTurn: null,
        incomplete: true,
        error: null,
        stats: { eventCount: 0 },
      });
    }

    // Callers reach this through `append`, which serializes it; the roll path
    // below recurses into it directly rather than re-entering the queue it is
    // already holding.
    async function appendNow(matchId, events, rawBytes) {
      const s = await session(matchId);
      const incoming = Array.isArray(events) ? events : [];
      const { events: lean, assets } = await extractCssAssets(incoming, { hash });

      for (const [ref, text] of assets) {
        if (s.cssRefs.has(ref)) continue;
        await idb.put("assets", { hash: ref, text });
        s.cssRefs.add(ref);
      }

      const raw = Number(rawBytes) || 0;
      const rolls =
        s.chunkRaw + raw > BATCH_MAX_RAW || Date.now() - s.openedAt >= BATCH_MAX_MS;
      if (s.events.length && rolls) {
        const closed = s.closedBytes + s.chunkBytes;
        sessions.set(matchId, newSession(s.seq + 1, s.eventCount, closed, s.rawBytes, s.cssRefs));
        return appendNow(matchId, incoming, raw);
      }

      s.events = s.events.concat(lean);
      s.eventCount += lean.length;
      s.chunkRaw += raw;
      s.rawBytes += raw;

      const bytes = await compress(encoder.encode(JSON.stringify(s.events)));
      s.chunkBytes = bytes.byteLength;
      await idb.put("chunks", {
        matchId,
        seq: s.seq,
        firstEventIdx: s.firstEventIdx,
        bytes,
      });

      const totalCompressedBytes = s.closedBytes + s.chunkBytes;
      await patchRecord(matchId, {
        chunkCount: s.seq + 1,
        compressedBytes: totalCompressedBytes,
        rawBytes: s.rawBytes,
        cssRefs: [...s.cssRefs],
        stats: { eventCount: s.eventCount },
      });
      return { compressedBytes: s.chunkBytes, totalCompressedBytes };
    }

    async function stopNow(matchId, options) {
      const o = options || {};
      sessions.delete(matchId);
      const truncatedAtTurn = o.truncatedAtTurn === undefined ? null : o.truncatedAtTurn;
      const state = stateFor(o.reason, truncatedAtTurn);
      // The recorder's own numbers (frame timings, keyframe count) arrive here
      // and only here; the store's eventCount stays authoritative.
      await patchRecord(matchId, (record) => ({
        endedAt: Date.now(),
        state,
        truncatedAtTurn,
        incomplete: state !== "complete",
        // Only an errored capture carries a reason to show; anything else would
        // put a stale message behind the dashboard's state pill.
        error: state === "error" && typeof o.error === "string" && o.error ? o.error : null,
        stats: Object.assign({}, o.stats || {}, record.stats),
      }));
    }

    const append = (matchId, events, rawBytes) =>
      enqueue(matchId, () => appendNow(matchId, events, rawBytes));
    const stop = (matchId, options) => enqueue(matchId, () => stopNow(matchId, options));

    async function get(matchId) {
      const record = await idb.get("replays", matchId);
      if (!record) return null;

      const chunks = ((await idb.getAll("chunks", chunkQuery(matchId))) || [])
        .filter((chunk) => chunk && chunk.matchId === matchId)
        .sort((a, b) => a.seq - b.seq);

      // A corrupt chunk truncates the replay rather than failing the read: the
      // events before it still play, and later ones assume DOM state we lost.
      const events = [];
      let truncatedAtChunk = null;
      for (const chunk of chunks) {
        try {
          const parsed = JSON.parse(decoder.decode(await decompress(chunk.bytes)));
          if (!Array.isArray(parsed)) throw new Error("chunk is not an event array");
          for (const event of parsed) events.push(event);
        } catch (_) {
          truncatedAtChunk = chunk.seq;
          break;
        }
      }

      const assets = new Map();
      for (const ref of record.cssRefs || []) {
        const asset = await idb.get("assets", ref);
        if (asset) assets.set(ref, asset.text);
      }

      return {
        meta: truncatedAtChunk === null ? record : Object.assign({}, record, { truncatedAtChunk }),
        events: rehydrateCssAssets(events, assets),
      };
    }

    async function list() {
      const all = await idb.getAll("replays");
      return Array.isArray(all) ? all : [];
    }

    async function gc(keepNewest) {
      const keep = Math.max(0, Number(keepNewest) || 0);
      const doomed = (await list())
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        .slice(keep);

      for (const record of doomed) {
        sessions.delete(record.matchId);
        // Drops replays + chunks only: assets are shared by content hash, so
        // they are reaped below against what is left rather than per match.
        await idb.clearMatch(record.matchId);
      }
      await reapAssets();
      return doomed.length;
    }

    /* Content-addressed stylesheets outlive the replays that referenced them -
     * every site redeploy mints new hashes - so nothing would ever free them
     * without this. An asset is live if a surviving record references it, or if
     * a recording session holds it: that session has already written the asset
     * but may not have patched its record with the ref yet. */
    async function reapAssets() {
      const live = new Set();
      for (const record of await list()) for (const ref of record.cssRefs || []) live.add(ref);
      for (const s of sessions.values()) for (const ref of s.cssRefs) live.add(ref);

      const assets = (await idb.getAll("assets")) || [];
      for (const asset of assets) {
        if (asset && !live.has(asset.hash)) await idb.del("assets", asset.hash);
      }
    }

    return { start, append, stop, get, list, gc };
  }

  root.RATrackerReplayStore = { createReplayStore, BATCH_MAX_RAW, BATCH_MAX_MS };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.RATrackerReplayStore;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
