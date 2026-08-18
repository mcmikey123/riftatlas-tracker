/* Rift Atlas Stats Tracker - share viewer support
 *
 * The pure half of the standalone share viewer: which message a failure earns,
 * whether every stylesheet reference resolved, and whether the card-art CDN
 * answered. `share/worker/public/viewer.js` is the DOM-and-network half and
 * gets no unit tests by project convention, so everything that can be decided
 * from data alone lives on this side of the line and is tested.
 *
 * The stylesheet check exists because the failure it catches is silent.
 * `rehydrateCssAssets` returns "" for a ref it cannot resolve — including for
 * every ref, when it is handed a plain object instead of a Map — and the
 * vendored rrweb only turns a <link> into a <style> when `_cssText` is truthy.
 * One wrong line therefore renders a completely unstyled board with no
 * exception and no console warning, which reads as ugly rather than broken.
 */
(function (root) {
  "use strict";

  // One message per remedy. A single "failed to load" would be useless here:
  // an expired share, a wrong key and an unreachable host need three different
  // things from the reader.
  const MESSAGES = {
    link: "This link is malformed.",
    missing: "This share has expired or was never uploaded.",
    network: "Couldn't reach the server.",
    server: "The server could not return this share.",
    key: "This link is incomplete or was altered.",
    format: "This isn't a valid replay file.",
    css: "This replay is missing its stylesheets.",
    engine: "The replay engine failed to load.",
    playback: "This replay could not be played back.",
    unknown: "Something went wrong opening this replay."
  };

  // Only the two transport failures can plausibly succeed on a second attempt.
  const RETRYABLE = ["network", "server"];

  // Errors thrown by share/hosts.js, share/payload.js and WebCrypto. The names
  // are the contract: payload.js documents that `OperationError` reaching the
  // viewer means a wrong key or tampered bytes, distinct from a bad frame.
  const BY_NAME = {
    ShareLinkError: "link",
    OperationError: "key",
    ShareFormatError: "format",
    ShareTruncatedError: "format"
  };

  /** A failure the viewer raised itself, carrying the kind it should report. */
  class ViewerError extends Error {
    constructor(kind, detail) {
      super(detail || MESSAGES[kind] || kind);
      this.name = "ViewerError";
      this.kind = kind;
    }
  }

  /** Which message an error earns; `fallbackKind` covers anything unrecognised. */
  function classify(err, fallbackKind) {
    if (err && typeof err.kind === "string" && MESSAGES[err.kind]) return err.kind;
    if (err && BY_NAME[err.name]) return BY_NAME[err.name];
    return MESSAGES[fallbackKind] ? fallbackKind : "unknown";
  }

  function describeFailure(err, fallbackKind) {
    const kind = classify(err, fallbackKind);
    return { kind, message: MESSAGES[kind], retry: RETRYABLE.indexOf(kind) !== -1 };
  }

  /**
   * Visit every attributes bag in every full snapshot's node tree. Deliberately
   * the same reach as `store/css-assets.js` `mapEvents` — only `event.data.node`
   * — so sheets arriving by mutation, which rehydration never touches either,
   * are not counted as failures here.
   */
  function walkAttributes(events, visit) {
    if (!Array.isArray(events)) return;
    for (const event of events) {
      const node = event && event.data && event.data.node;
      if (!node) continue;
      const stack = [node];
      while (stack.length) {
        const current = stack.pop();
        if (!current || typeof current !== "object") continue;
        if (current.attributes && typeof current.attributes === "object") visit(current.attributes);
        if (Array.isArray(current.childNodes)) {
          for (const child of current.childNodes) stack.push(child);
        }
      }
    }
  }

  /** Every distinct `__cssRef` the stripped event stream expects to resolve. */
  function cssRefsIn(events) {
    const refs = new Set();
    walkAttributes(events, (attributes) => {
      if (typeof attributes.__cssRef === "string") refs.add(attributes.__cssRef);
    });
    return [...refs];
  }

  /**
   * The refs `assets` cannot satisfy, checked before rehydration rather than
   * after: it costs one walk instead of stringifying an event stream that
   * reaches tens of megabytes once the CSS is back inline. A plain object
   * reports every ref as unresolved, which is exactly the wanted outcome — that
   * is the mistake this function exists to catch.
   */
  function unresolvedCssRefs(events, assets) {
    const resolves = (ref) => {
      if (!assets || typeof assets.get !== "function") return false;
      const text = assets.get(ref);
      return typeof text === "string" && text.length > 0;
    };
    return cssRefsIn(events).filter((ref) => !resolves(ref));
  }

  /**
   * Rehydrated bags left with an empty `_cssText`. The second half of the same
   * guard, run on the output: rrweb treats an empty string as "no stylesheet"
   * and silently leaves the node as an unresolvable <link>.
   */
  function emptyCssTextCount(events) {
    let count = 0;
    walkAttributes(events, (attributes) => {
      if (attributes._cssText === "") count++;
    });
    return count;
  }

  /**
   * How the card art from `origin` actually fared: how many finished with
   * something in them, and how many finished empty.
   *
   * Both halves, because the count of failures alone cannot tell "the image
   * host is down" from "one card's art 404s". Reporting the second as the
   * first is what this returns two numbers to prevent: a replay whose cards
   * are all on screen bar one is not a replay with an unreachable image
   * server, and saying so trains the reader to ignore the banner that matters.
   *
   * Images still in flight are counted as neither - `complete` is false until
   * they settle, and a slow image is not a failed one.
   *
   * Takes any iterable of image-likes so it can be tested without a DOM.
   */
  function cardArtHealth(images, origin) {
    let loaded = 0;
    let broken = 0;
    const brokenSrc = [];
    for (const img of images || []) {
      if (!img || !img.complete) continue;
      const src = String(img.src || "");
      if (origin && src.indexOf(origin) !== 0) continue;
      if (img.naturalWidth > 0) loaded++;
      else {
        broken++;
        if (brokenSrc.length < 5) brokenSrc.push(src);
      }
    }
    return { loaded, broken, brokenSrc };
  }

  /**
   * Whether the card-art host should be called unreachable.
   *
   * Only when nothing from it arrived at all. One failure among many is one
   * card's art, and the viewer has nothing useful to say about that; the
   * reader can see the gap, and the rest of the replay genuinely is unaffected.
   */
  function cardArtUnreachable({ loaded, broken }) {
    return broken > 0 && loaded === 0;
  }

  /**
   * How many images from `origin` finished loading with nothing in them.
   * Retained because it is the narrower question and is still the one the
   * count-based tests ask.
   */
  function brokenImages(images, origin) {
    return cardArtHealth(images, origin).broken;
  }

  /**
   * m:ss for the transport clock. Duplicated from `dashboard/format.js` rather
   * than shared: that file is the dashboard's, and the viewer is served from a
   * different origin with only the files sync-assets.sh copies.
   */
  function fmtClock(ms) {
    if (!Number.isFinite(ms)) return "0:00";
    const t = Math.max(0, Math.round(ms / 1000));
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
  }

  // Same dual export as store/css-assets.js: a global for the browser, CommonJS for tests.
  const api = {
    MESSAGES,
    ViewerError,
    classify,
    describeFailure,
    cssRefsIn,
    unresolvedCssRefs,
    emptyCssTextCount,
    brokenImages,
    cardArtHealth,
    cardArtUnreachable,
    fmtClock
  };

  root.RAShareViewer = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
