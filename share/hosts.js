// Link construction and parsing, plus the registry of things that can store a share.
//
// Link: https://<endpoint>/#<version>.<object-id>.<key>
//
// The leading character is a LINK FORMAT VERSION, not a host id. The viewer is served by
// the same Worker that stores the object, so its own origin already identifies the backend
// and nothing in the link needs to say where to look. Host ids stay internal to this file,
// where they select an uploader. A second backend would ship as version "2" with a host field.
//
// The key rides in the fragment so it never reaches the instance's request logs.
(function (root) {
  "use strict";

  const LINK_VERSION = "1";
  const KEY_BYTES = 32;
  const KEY_CHARS = 43; // 32 bytes, base64url, unpadded
  // Must equal the base64url length of the Worker's OBJECT_ID_BYTES
  // (share/worker/src/worker.js). Change one and every new link stops parsing.
  const OBJECT_ID_CHARS = 22; // 128 bits, base64url, unpadded

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

  function buildLink({ endpoint, objectId, keyBytes }) {
    return `${normaliseEndpoint(endpoint)}/#${LINK_VERSION}.${objectId}.${toBase64Url(keyBytes)}`;
  }

  function parseLink(input) {
    const text = String(input);
    const at = text.indexOf("#");
    if (at === -1) throw new ShareLinkError("link has no fragment");
    const hash = text.slice(at);

    const parts = hash.slice(1).split(".");
    if (parts.length !== 3) throw new ShareLinkError("link fragment is malformed");

    const [version, objectId, keyText] = parts;
    if (version !== LINK_VERSION) {
      throw new ShareLinkError("this link uses a newer format than this viewer understands");
    }
    if (objectId.length !== OBJECT_ID_CHARS || !/^[A-Za-z0-9_-]+$/.test(objectId)) {
      throw new ShareLinkError("link fragment is malformed");
    }
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
    } catch (cause) {
      throw new ShareLinkError("link key is not valid base64url");
    }
    if (keyBytes.length !== KEY_BYTES) throw new ShareLinkError("link key is the wrong length");

    return { version, objectId, keyBytes };
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
      const { id } = await res.json();
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
    toBase64Url,
    fromBase64Url,
    normaliseEndpoint,
    buildLink,
    parseLink,
    hostFor
  };

  root.RAShareHosts = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
