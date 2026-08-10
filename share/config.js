// Which share instance the extension talks to.
//
// This is a public URL, not a secret. It points at the instance run by the contributor;
// change it in Settings, or deploy your own -- see share/worker/README.md.
//
// SHARE_TOKEN is NOT a secret either, and must not be treated as one. It ships inside a
// distributed browser extension, so anyone can read it out of the source or the repo. It is
// a speed bump against casual scripted abuse of the endpoint, nothing more. The controls
// that actually matter are the size cap, the per-IP rate limit, the 7-day TTL, and the
// Workers Free daily request ceiling -- see docs/adr/0001-remain-on-the-workers-free-plan.md.
(function (root) {
  "use strict";

  const api = {
    DEFAULT_SHARE_ENDPOINT: "https://riftatlas-replay-share.curtyo18.workers.dev",
    SHARE_TOKEN: "lIIeOg4XLteSr2dm66MzmieY"
  };

  root.RAShareConfig = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
