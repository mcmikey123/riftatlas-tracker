// The size-cap decision for PUT /u, as a pure function.
//
// Extracted because this is the single control the whole abuse model rests on, and while
// it lived inline in the request handler it had no test coverage at all. An earlier
// revision let the cap vanish silently whenever MAX_UPLOAD_BYTES was unset or misspelled:
// Number(undefined) is NaN, every comparison against NaN is false, and the 413 never
// fired. A misconfigured instance must refuse uploads, not accept unbounded ones.
(function (root) {
  "use strict";

  // Deliberately stricter than Number(): that accepts " 100", "0x10" and "12.5", none of
  // which are meaningful as a byte count and the last of which reaches FixedLengthStream
  // as a fraction.
  function parseByteCount(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!/^\d+$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  // → { ok: true, bytes, limit } | { ok: false, status, body }
  function checkUploadSize(contentLengthHeader, maxBytesVar) {
    const limit = parseByteCount(maxBytesVar);
    if (limit === null) {
      // Fail closed: the operator broke the config, so no upload is safe to accept.
      return { ok: false, status: 500, body: { error: "server misconfigured" } };
    }

    const declared = parseByteCount(contentLengthHeader);
    if (declared === null) {
      return { ok: false, status: 411, body: { error: "content-length required", limit } };
    }
    if (declared > limit) {
      return { ok: false, status: 413, body: { error: "too large", limit, declared } };
    }
    return { ok: true, bytes: declared, limit };
  }

  const api = { parseByteCount, checkUploadSize };

  root.RAUploadSize = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
