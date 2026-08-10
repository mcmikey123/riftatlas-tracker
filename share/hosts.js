// Link construction and parsing, plus the registry of things that can store a share.
//
// Link: https://<endpoint>/#<version>.<object-id>.<key>[.<seconds>]
//
// The leading character is a LINK FORMAT VERSION, not a host id. The viewer is served by
// the same Worker that stores the object, so its own origin already identifies the backend
// and nothing in the link needs to say where to look. Host ids stay internal to this file,
// where they select an uploader. A second backend would ship as version "2" with a host field.
//
// The key rides in the fragment so it never reaches the instance's request logs.
//
// THE OPTIONAL FOURTH FIELD is a playback position in whole seconds: "open this replay at
// this moment". Three decisions are worth stating, because each has an obvious-looking
// alternative that is wrong:
//
//   Why not `?t=`. The key is in the fragment precisely so it never reaches Cloudflare or
//   the browser's history; a querystring would be sent. That alone is enough, but the
//   practical reason matters more. `https://host/?t=5&#1.id.key` is the correct form and
//   `https://host/#1.id.key?t=5` is what people actually produce by hand or after a chat
//   client reflows a URL - and there the `?t=5` is swallowed into the key, which then fails
//   to decrypt with an error about the link being altered. A fourth fragment field cannot
//   be got wrong that way.
//
//   Why seconds. Sub-second precision is noise on a replay minutes long, and three fewer
//   characters is three fewer chances for a line wrap to break the link.
//
//   Why still version "1", accepting three parts or four. The viewer parses links with THIS
//   FILE: share/worker/sync-assets.sh copies it into the Worker's static assets, so the
//   builder and the parser are the same source. A version number earns its keep when two
//   independent implementations can disagree about a format; here they cannot, and the only
//   skew possible is a browser holding a cached copy of an older deploy - which minting "2"
//   would relabel from "malformed" to "newer format" without making the link work. Against
//   that, "1" accepting an optional field is purely additive: every link already in the wild
//   keeps parsing, there is one format to reason about rather than two, and the version stays
//   available for the change it was reserved for, which is a second storage backend.
(function (root) {
  "use strict";

  const LINK_VERSION = "1";
  const KEY_BYTES = 32;
  const KEY_CHARS = 43; // 32 bytes, base64url, unpadded
  // Must equal the base64url length of the Worker's OBJECT_ID_BYTES
  // (share/worker/src/worker.js). Change one and every new link stops parsing.
  const OBJECT_ID_CHARS = 22; // 128 bits, base64url, unpadded

  // One shape, checked in both directions: on the way in from a link fragment,
  // and on the way back out of an upload. An id that fails this cannot produce
  // a link that survives a round trip - share/share-ui-support.js applies the
  // same test when it reads the stored share list back, and silently drops any
  // record that fails it, taking the only copy of the key with it.
  const OBJECT_ID_RE = new RegExp(`^[A-Za-z0-9_-]{${OBJECT_ID_CHARS}}$`);
  const isObjectId = (value) => typeof value === "string" && OBJECT_ID_RE.test(value);

  class ShareLinkError extends Error {
    constructor(message) {
      super(message);
      this.name = "ShareLinkError";
    }
  }

  function toBase64Url(bytes) {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(text) {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function normaliseEndpoint(endpoint) {
    return String(endpoint).replace(/\/+$/, "");
  }

  /**
   * A playback position in milliseconds as the link's whole-seconds field, or
   * null when there is no usable position. Floored, never rounded: rounding up
   * would produce a link that opens a moment the sharer had not reached yet.
   */
  function toLinkSeconds(ms) {
    const n = toPosition(ms);
    return n === null ? null : Math.floor(n / 1000);
  }

  /** The inverse: a link's seconds field back to milliseconds, or null. */
  function fromLinkSeconds(atSeconds) {
    const n = toPosition(atSeconds);
    return n === null ? null : Math.floor(n) * 1000;
  }

  /**
   * A position as a non-negative finite number, or null for anything that is
   * not one. Null, undefined and "" are rejected before `Number` sees them:
   * `Number(null)` is 0, and a caller passing "no position" must never come
   * back with "the very beginning" - in `buildLink` that is the difference
   * between a link that carries no timestamp and one that pins it to 0:00.
   */
  function toPosition(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  /**
   * The seconds field as it appears in a fragment, or null.
   *
   * Digits only, so a negative, fractional, blank or non-numeric field reads as
   * "no timestamp" rather than as a broken link. That is deliberate: the
   * timestamp is a convenience and the replay plays perfectly without it, so a
   * field mangled in transit must never cost the recipient the whole share.
   */
  function parseLinkSeconds(text) {
    if (typeof text !== "string" || !/^[0-9]+$/.test(text)) return null;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : null;
  }

  /**
   * `atSeconds` is optional and omitted from the link entirely when absent, so
   * every existing caller keeps producing exactly the link it produced before.
   */
  function buildLink({ endpoint, objectId, keyBytes, atSeconds }) {
    const n = toPosition(atSeconds);
    const moment = n === null ? "" : "." + Math.floor(n);
    return `${normaliseEndpoint(endpoint)}/#${LINK_VERSION}.${objectId}.${toBase64Url(keyBytes)}${moment}`;
  }

  function parseLink(input) {
    const text = String(input);
    const at = text.indexOf("#");
    if (at === -1) throw new ShareLinkError("link has no fragment");
    const hash = text.slice(at);

    const parts = hash.slice(1).split(".");
    // Three or four: the fourth is the optional playback position. Five is not a
    // format anyone has ever shipped, so it is a mangled link, not a future one.
    if (parts.length < 3 || parts.length > 4) throw new ShareLinkError("link fragment is malformed");

    const [version, objectId, keyText, timeText] = parts;
    if (version !== LINK_VERSION) {
      throw new ShareLinkError("this link uses a newer format than this viewer understands");
    }
    if (!isObjectId(objectId)) throw new ShareLinkError("link fragment is malformed");
    // Length is checked before decoding, not after. The alphabet test alone lets through
    // strings whose length makes them invalid base64, and atob then throws a DOMException
    // that escapes this file's error taxonomy — the viewer switches on that taxonomy to
    // choose which of four remedies to show, and a DOMException matches none of them.
    if (keyText.length !== KEY_CHARS || !/^[A-Za-z0-9_-]+$/.test(keyText)) {
      throw new ShareLinkError("link key is the wrong length");
    }

    let keyBytes;
    try {
      keyBytes = fromBase64Url(keyText);
    } catch (_) {
      throw new ShareLinkError("link key is not valid base64url");
    }
    if (keyBytes.length !== KEY_BYTES) throw new ShareLinkError("link key is the wrong length");

    // Not clamped here - this file has no idea how long the recording is. The
    // clamp is replay-timeline.js's `startPosition`, which does.
    return { version, objectId, keyBytes, atSeconds: parseLinkSeconds(timeText) };
  }

  // upload() is the only impure member. fetch is a parameter rather than a closed-over
  // global so its failure branches can be tested with a stub and no network.
  const WORKER_HOST = {
    id: "w",
    async upload(bytes, { endpoint, token, fetch: doFetch }) {
      const res = await doFetch(`${normaliseEndpoint(endpoint)}/u`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "x-share-token": token },
        body: bytes
      });
      if (!res.ok) {
        const err = new Error(`upload failed with ${res.status}`);
        err.status = res.status;
        throw err;
      }
      /* A 2xx is not yet an answer. Both of these carry `.status` so the
       * dashboard's failure mapping reads them as a refusal from an endpoint
       * that answered, not as a transport failure - telling someone to check
       * their connection when the connection worked perfectly is the one
       * wrong thing to say here. */
      let body;
      try {
        body = await res.json();
      } catch (_) {
        const err = new Error("the share endpoint answered with something that isn't JSON");
        err.status = res.status;
        throw err;
      }
      const id = body && body.id;
      // An id that is not the shape a link is made of would be shown, verified
      // and stored, and then dropped by the share list's own validation - which
      // discards the key with it, since the record is the only copy.
      if (!isObjectId(id)) {
        const err = new Error("the share endpoint returned no usable object id");
        err.status = res.status;
        throw err;
      }
      return id;
    }
  };

  const HOSTS = { [WORKER_HOST.id]: WORKER_HOST };

  function hostFor(id) {
    const host = HOSTS[id];
    if (!host) throw new ShareLinkError(`unknown share host "${id}"`);
    return host;
  }

  // Same dual export as store/css-assets.js: a global for the extension, CommonJS for tests.
  const api = {
    ShareLinkError,
    LINK_VERSION,
    KEY_BYTES,
    KEY_CHARS,
    OBJECT_ID_CHARS,
    isObjectId,
    toBase64Url,
    fromBase64Url,
    normaliseEndpoint,
    toLinkSeconds,
    fromLinkSeconds,
    parseLinkSeconds,
    buildLink,
    parseLink,
    hostFor
  };

  root.RAShareHosts = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
