/* Rift Atlas Stats Tracker - share UI support
 *
 * The pure half of the dashboard's Share control: how big a payload reads as,
 * whether it may be uploaded at all, which message a failure earns, and the
 * shape of the record a successful share leaves behind. `dashboard/dashboard.js`
 * is the DOM, crypto and network half and gets no unit tests by project
 * convention, so everything decidable from data alone lives here and is tested.
 *
 * `share/viewer-support.js` is the same idea for the standalone viewer. The two
 * are deliberately separate: the viewer ships to a different origin with only
 * the files sync-assets.sh copies, and it never uploads anything.
 */
(function (root) {
  "use strict";

  // Must equal MAX_UPLOAD_BYTES in share/worker/wrangler.toml.example. The cap is
  // headroom, not abuse control - the worst replay measured builds a 3.48 MB
  // frame, so this is 3.4x the real ceiling. Refusing here rather than at the
  // Worker means the user learns the size instead of watching a PUT fail.
  const MAX_UPLOAD_BYTES = 12582912;

  // Fixed at the bucket by an R2 lifecycle rule, not per share. Nothing in the
  // extension can change it, and nothing can revoke a share before it elapses.
  const SHARE_TTL_DAYS = 7;
  const SHARE_TTL_MS = SHARE_TTL_DAYS * 86400000;

  // "RAR1" - the first four bytes of a share frame, per share/payload.js. The
  // post-upload check re-reads them from the endpoint under normal browser rules
  // before any link is shown, which is what catches a host that answers a curl
  // probe correctly and serves a browser an HTML interstitial instead.
  const MAGIC = [0x52, 0x41, 0x52, 0x31];

  // One message per remedy. A single "sharing failed" would be useless: a
  // rejected token, an oversized replay and a rate limit need three different
  // things from the user.
  const MESSAGES = {
    rejected: "The share endpoint rejected this upload. Check the share endpoint in Settings.",
    tooLarge: "The share endpoint refused this replay as too large.",
    rateLimited: "Too many uploads just now - try again in a few minutes.",
    unavailable: "Sharing is temporarily unavailable. Try again later.",
    misconfigured: "The share endpoint is misconfigured and cannot accept uploads.",
    network: "Couldn't reach the share endpoint. Check your connection and try again.",
    unverified:
      "The upload could not be confirmed, so no link is being shown. " +
      "Try again - the unconfirmed copy expires on its own.",
    unreadable: "The replay for this match could not be read."
  };

  // Only a rate limit, a temporary outage, a transport failure and an
  // unconfirmed upload can plausibly succeed on a second attempt. A 403 or a
  // 413 will fail identically every time, so offering a retry would be a lie.
  const RETRYABLE = ["rateLimited", "unavailable", "network", "unverified"];

  const BY_STATUS = {
    403: "rejected",
    411: "rejected",
    413: "tooLarge",
    429: "rateLimited",
    500: "misconfigured",
    503: "unavailable"
  };

  /** Bytes as B / KB / MB, matching how the capture panel prints sizes. */
  function fmtSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n)) return "an unknown size";
    if (n < 1024) return Math.round(n) + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }

  /**
   * Whether a built frame may be uploaded. Takes the frame's real byteLength -
   * never `meta.compressedBytes`, which is the store's per-chunk total and
   * differs from a whole-stream frame (3,760,696 against 3,644,834 on the
   * measured worst case).
   */
  function checkPayloadSize(bytes, limit) {
    const size = Number(bytes);
    const cap = Number(limit);
    if (!Number.isFinite(size) || size <= 0) {
      return { ok: false, kind: "empty", message: "This replay produced an empty share." };
    }
    if (!Number.isFinite(cap) || cap <= 0) {
      return { ok: false, kind: "misconfigured", message: MESSAGES.misconfigured };
    }
    if (size > cap) {
      return { ok: false, kind: "tooLarge", message: oversizeMessage(size, cap) };
    }
    return { ok: true, bytes: size, limit: cap };
  }

  function oversizeMessage(bytes, limit) {
    return (
      `This replay is ${fmtSize(bytes)} once compressed and encrypted, over the ` +
      `${fmtSize(limit)} a share may be. It can't be shared.`
    );
  }

  /**
   * Which message an upload failure earns. `share/hosts.js` puts the HTTP status
   * on the error; a transport failure has none, which is how a rejected fetch is
   * told apart from a refusal the endpoint actually sent.
   */
  function describeUploadFailure(err) {
    const status = err && Number(err.status);
    let kind;
    if (!Number.isFinite(status) || status <= 0) kind = "network";
    else if (BY_STATUS[status]) kind = BY_STATUS[status];
    else kind = status >= 500 ? "unavailable" : "rejected";
    return { kind, message: MESSAGES[kind], retry: RETRYABLE.indexOf(kind) !== -1 };
  }

  /** Whether a buffer opens with the share frame's magic bytes. */
  function hasShareMagic(bytes) {
    if (!bytes || bytes.length < MAGIC.length) return false;
    for (let i = 0; i < MAGIC.length; i++) {
      if (bytes[i] !== MAGIC[i]) return false;
    }
    return true;
  }

  /**
   * The record a successful share leaves in `chrome.storage.local` under the
   * `shares` key, which holds an array of these in creation order.
   *
   *   matchId    string   the match whose replay was shared
   *   objectId   string   22-char base64url id of the object at the endpoint
   *   key        string   43-char base64url AES-GCM-256 key. Stored because it
   *                       exists nowhere else - the endpoint never sees it, and
   *                       without it the link cannot be rebuilt, only lost.
   *   endpoint   string   the instance uploaded to, trailing slash stripped.
   *                       Recorded per share because the setting can change.
   *   createdAt  number   ms since epoch; the 7-day TTL counts from here.
   *
   * Rebuild the link with:
   *   RAShareHosts.buildLink({
   *     endpoint: record.endpoint,
   *     objectId: record.objectId,
   *     keyBytes: RAShareHosts.fromBase64Url(record.key)
   *   })
   *
   * The record is local bookkeeping only. Deleting it does not delete the
   * object, and there is no way to delete the object early - see
   * docs/specs/2026-08-10-replay-sharing-design.md.
   */
  function shareRecord(fields) {
    const f = fields || {};
    const record = {
      matchId: String(f.matchId == null ? "" : f.matchId),
      objectId: String(f.objectId == null ? "" : f.objectId),
      key: String(f.key == null ? "" : f.key),
      endpoint: String(f.endpoint == null ? "" : f.endpoint).replace(/\/+$/, ""),
      createdAt: Number(f.createdAt)
    };
    // A record missing any field is worse than no record: the shares list would
    // show an entry whose link cannot be rebuilt and whose expiry is unknowable.
    for (const name of ["matchId", "objectId", "key", "endpoint"]) {
      if (!record[name]) throw new Error(`a share record needs a ${name}`);
    }
    if (!Number.isFinite(record.createdAt) || record.createdAt <= 0) {
      throw new Error("a share record needs a createdAt timestamp");
    }
    return record;
  }

  /** When the bucket's lifecycle rule will have removed a share's object. */
  function expiresAt(record) {
    return Number(record && record.createdAt) + SHARE_TTL_MS;
  }

  /** Whether a share has passed its TTL. Nothing here can bring it back. */
  function isExpired(record, now) {
    return Number(now) >= expiresAt(record);
  }

  const MINUTE_MS = 60000;
  const HOUR_MS = 3600000;
  const DAY_MS = 86400000;

  function plural(n, unit) {
    return `${n} ${unit}${n === 1 ? "" : "s"}`;
  }

  /**
   * How long a share has left, or how long ago it went, in words.
   *
   * Always rounded down. "in 6 days" on a share with 6.9 days left costs
   * nothing; "in 7 days" on one with 6.1 days left promises time the bucket
   * will not give, and the whole point of the shares list is that its dates
   * are the only warning anyone gets.
   */
  function expiryText(record, now) {
    const left = expiresAt(record) - Number(now);
    if (left <= 0) {
      const gone = -left;
      if (gone >= DAY_MS) return `expired ${plural(Math.floor(gone / DAY_MS), "day")} ago`;
      if (gone >= HOUR_MS) return `expired ${plural(Math.floor(gone / HOUR_MS), "hour")} ago`;
      if (gone >= MINUTE_MS) return `expired ${plural(Math.floor(gone / MINUTE_MS), "minute")} ago`;
      return "expired just now";
    }
    if (left >= DAY_MS) return `in ${plural(Math.floor(left / DAY_MS), "day")}`;
    if (left >= HOUR_MS) return `in ${plural(Math.floor(left / HOUR_MS), "hour")}`;
    if (left >= MINUTE_MS) return `in ${plural(Math.floor(left / MINUTE_MS), "minute")}`;
    return "in under a minute";
  }

  // What a link is made of, so a record that cannot produce one is caught
  // before it becomes a row. Both are unpadded base64url of a fixed length:
  // 128 bits of object id, 256 bits of key.
  const OBJECT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
  const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

  /**
   * The stored `shares` array as rows to render: valid records only, newest
   * first. Anything unusable is dropped rather than shown, because a row whose
   * link cannot be rebuilt is worse than no row - it claims a share exists and
   * offers no way to reach it. Nothing is written back; dropping a record here
   * does not delete anything, and could not delete the object even if it did.
   */
  function readShareList(raw) {
    const rows = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      let record;
      try {
        record = shareRecord(entry);
      } catch (_) {
        continue; // half-built or from a format this build doesn't know
      }
      if (!OBJECT_ID_RE.test(record.objectId) || !KEY_RE.test(record.key)) continue;
      rows.push(record);
    }
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * What a re-check learned. Three outcomes, deliberately not two: "couldn't
   * reach the endpoint" is not "expired", and reporting it as expired would
   * tell someone their share was gone when it is still being served.
   */
  const RECHECK_MESSAGES = {
    alive: "Still on the endpoint - this link opens.",
    gone: "Gone from the endpoint. It expired, or the operator removed it. This link opens to nothing.",
    unreachable:
      "Couldn't reach the share endpoint, so nothing was learned about this share either way.",
    unexpected:
      "The endpoint answered with something that isn't a replay, so nothing was learned about " +
      "this share either way."
  };

  const RECHECK_LABELS = { alive: "still there", gone: "gone", unreachable: "no answer" };

  const out = (state, message) => ({ state, label: RECHECK_LABELS[state], message });

  /**
   * `outcome` is what a HEAD-sized GET of `<endpoint>/b/<objectId>` produced:
   *
   *   reached  boolean  the endpoint answered at all
   *   status   number   its HTTP status
   *   magic    boolean  whether the first four bytes are the RAR1 magic
   *
   * The magic check is the same one the post-upload verification uses: a host
   * that answers 200 with an HTML interstitial is not serving the share.
   */
  function describeRecheck(outcome) {
    const o = outcome || {};
    if (!o.reached) return out("unreachable", RECHECK_MESSAGES.unreachable);

    const status = Number(o.status);
    // 410 is not served today, but it means exactly "gone" and mistaking it
    // for a transient failure would be the one wrong answer here.
    if (status === 404 || status === 410) return out("gone", RECHECK_MESSAGES.gone);
    if (status === 200 || status === 206) {
      return o.magic
        ? out("alive", RECHECK_MESSAGES.alive)
        : out("unreachable", RECHECK_MESSAGES.unexpected);
    }
    return out(
      "unreachable",
      `The share endpoint answered ${Number.isFinite(status) ? status : "oddly"}, so nothing was ` +
        "learned about this share either way."
    );
  }

  // Same dual export as store/css-assets.js: a global for the extension, CommonJS for tests.
  const api = {
    MAX_UPLOAD_BYTES,
    SHARE_TTL_DAYS,
    SHARE_TTL_MS,
    MESSAGES,
    RECHECK_MESSAGES,
    fmtSize,
    checkPayloadSize,
    oversizeMessage,
    describeUploadFailure,
    hasShareMagic,
    shareRecord,
    expiresAt,
    isExpired,
    expiryText,
    readShareList,
    describeRecheck
  };

  root.RAShareUI = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
