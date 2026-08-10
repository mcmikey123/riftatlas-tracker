// Build and parse the encrypted frame that carries a shared replay.
//
// Frame: "RAR1" (4) | flags (1) | IV (12) | ciphertext | GCM tag (16) = 33 bytes overhead.
// Compress THEN encrypt; the reverse makes compression useless.
//
// The magic is what lets the viewer tell "not a replay" from "wrong key" from "the host
// returned junk" — three failures whose remedies have nothing in common.
//
// crypto and the compression streams are injected so tests can stub them, exactly as
// store/replay-store.js already does.
(function (root) {
  "use strict";

  // "RAR1". Exported and frozen because it is not only this file's: anything
  // that recognises a share frame - the dashboard's post-upload verification,
  // the shares list's re-check - must read the bytes from here rather than
  // restate them, or the two copies drift and the check stops checking.
  const MAGIC = Object.freeze([0x52, 0x41, 0x52, 0x31]);
  const FLAG_DEFLATE = 0x01;
  const KNOWN_FLAGS = FLAG_DEFLATE;
  const IV_BYTES = 12;
  const HEADER_BYTES = MAGIC.length + 1 + IV_BYTES; // 17
  const TAG_BYTES = 16;

  class ShareFormatError extends Error {
    constructor(message) {
      super(message);
      this.name = "ShareFormatError";
    }
  }

  class ShareTruncatedError extends Error {
    constructor(message) {
      super(message);
      this.name = "ShareTruncatedError";
    }
  }

  function subtleOf(deps) {
    return (deps && deps.crypto ? deps.crypto : globalThis.crypto).subtle;
  }

  function randomBytes(deps, n) {
    const c = deps && deps.crypto ? deps.crypto : globalThis.crypto;
    return c.getRandomValues(new Uint8Array(n));
  }

  async function defaultCompress(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function defaultDecompress(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function compressorOf(deps) {
    return (deps && deps.compress) || defaultCompress;
  }

  function decompressorOf(deps) {
    return (deps && deps.decompress) || defaultDecompress;
  }

  async function generateKey(deps) {
    return subtleOf(deps).generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt"
    ]);
  }

  async function exportKey(key, deps) {
    return new Uint8Array(await subtleOf(deps).exportKey("raw", key));
  }

  async function importKey(raw, deps) {
    return subtleOf(deps).importKey("raw", raw, { name: "AES-GCM" }, true, [
      "encrypt",
      "decrypt"
    ]);
  }

  async function buildSharePayload(payload, key, deps) {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const deflated = await compressorOf(deps)(json);
    const iv = randomBytes(deps, IV_BYTES);
    const sealed = new Uint8Array(
      await subtleOf(deps).encrypt({ name: "AES-GCM", iv }, key, deflated)
    );

    const frame = new Uint8Array(HEADER_BYTES + sealed.length);
    frame.set(MAGIC, 0);
    frame[MAGIC.length] = FLAG_DEFLATE;
    frame.set(iv, MAGIC.length + 1);
    frame.set(sealed, HEADER_BYTES);
    return frame;
  }

  async function parseSharePayload(bytes, key, deps) {
    // Magic before length. A short blob that was never a share frame is "not a replay",
    // not "truncated" — the viewer offers completely different remedies for the two, and
    // checking length first misreports every wrong-file case as a truncation.
    if (bytes.length < MAGIC.length) {
      throw new ShareTruncatedError("share frame is too short to identify");
    }
    for (let i = 0; i < MAGIC.length; i++) {
      if (bytes[i] !== MAGIC[i]) {
        throw new ShareFormatError("not a Rift Atlas replay share");
      }
    }
    if (bytes.length < HEADER_BYTES + TAG_BYTES) {
      throw new ShareTruncatedError("share frame is shorter than an empty frame");
    }

    const flags = bytes[MAGIC.length];
    if (flags & ~KNOWN_FLAGS) {
      throw new ShareFormatError("share frame uses a newer format than this viewer understands");
    }
    if (!(flags & FLAG_DEFLATE)) {
      throw new ShareFormatError("share frame is missing the compression flag");
    }

    const iv = bytes.subarray(MAGIC.length + 1, HEADER_BYTES);
    const sealed = bytes.subarray(HEADER_BYTES);

    // Propagates OperationError on a wrong key or tampered bytes. That name is
    // load-bearing: the viewer distinguishes it from a format error.
    const deflated = new Uint8Array(
      await subtleOf(deps).decrypt({ name: "AES-GCM", iv }, key, sealed)
    );
    const json = await decompressorOf(deps)(deflated);
    return JSON.parse(new TextDecoder().decode(json));
  }

  // Same dual export as store/css-assets.js: a global for the extension, CommonJS for tests.
  const api = {
    ShareFormatError,
    ShareTruncatedError,
    MAGIC,
    HEADER_BYTES,
    TAG_BYTES,
    generateKey,
    exportKey,
    importKey,
    buildSharePayload,
    parseSharePayload
  };

  root.RAShare = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
