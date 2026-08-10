// Content-addressed stylesheet storage for rrweb event streams.
//
// rrweb inlines stylesheet text into `attributes._cssText` on <style>/<link>
// nodes, and repeats it in full on every keyframe. Extraction swaps that text
// for `attributes.__cssRef = hash(text)` and hands back the hash -> text map,
// so the same sheet is persisted once no matter how often it is snapshotted.
//
// Pure: no crypto, no I/O, no chrome APIs. The hash function is injected, which
// is the only reason `extractCssAssets` is async. Neither function mutates its
// input; unchanged subtrees are returned by reference so large event batches
// are not needlessly cloned.
(function (root) {
  "use strict";

  const DEFAULT_MIN_BYTES = 2048;

  // Rebuilds a node tree with `mapAttributes` applied to every attributes bag.
  // Returns the original node whenever nothing below it changed.
  function mapNode(node, mapAttributes) {
    if (!node || typeof node !== "object") return node;

    const attributes =
      node.attributes && typeof node.attributes === "object"
        ? mapAttributes(node.attributes)
        : node.attributes;

    let childNodes = node.childNodes;
    if (Array.isArray(childNodes)) {
      const mapped = childNodes.map((child) => mapNode(child, mapAttributes));
      if (mapped.some((child, i) => child !== childNodes[i])) childNodes = mapped;
    }

    if (attributes === node.attributes && childNodes === node.childNodes) return node;

    const next = Object.assign({}, node);
    if (attributes !== node.attributes) next.attributes = attributes;
    if (childNodes !== node.childNodes) next.childNodes = childNodes;
    return next;
  }

  // Applies `mapAttributes` across the snapshot tree of every full-snapshot
  // event, preserving the identity of events it did not have to touch.
  function mapEvents(events, mapAttributes) {
    if (!Array.isArray(events)) return events;
    return events.map((event) => {
      const node = event && event.data && event.data.node;
      if (!node) return event;
      const nextNode = mapNode(node, mapAttributes);
      if (nextNode === node) return event;
      const nextData = Object.assign({}, event.data, { node: nextNode });
      return Object.assign({}, event, { data: nextData });
    });
  }

  async function extractCssAssets(events, options) {
    const opts = options || {};
    const minBytes = opts.minBytes === undefined ? DEFAULT_MIN_BYTES : opts.minBytes;
    const hash = opts.hash;
    const assets = new Map();

    const oversized = (attributes) =>
      typeof attributes._cssText === "string" && attributes._cssText.length > minBytes;

    // Collect first so each distinct sheet is hashed exactly once, then swap in
    // the refs synchronously.
    const texts = new Set();
    mapEvents(events, (attributes) => {
      if (oversized(attributes)) texts.add(attributes._cssText);
      return attributes;
    });

    const refs = new Map();
    for (const text of texts) {
      const ref = await hash(text);
      refs.set(text, ref);
      assets.set(ref, text);
    }

    return {
      events: mapEvents(events, (attributes) => {
        if (!oversized(attributes)) return attributes;
        const next = Object.assign({}, attributes, { __cssRef: refs.get(attributes._cssText) });
        delete next._cssText;
        return next;
      }),
      assets,
    };
  }

  function rehydrateCssAssets(events, assets) {
    const lookup = (ref) => {
      const text = assets && typeof assets.get === "function" ? assets.get(ref) : undefined;
      return typeof text === "string" ? text : "";
    };

    return mapEvents(events, (attributes) => {
      if (typeof attributes.__cssRef !== "string") return attributes;
      const next = Object.assign({}, attributes, { _cssText: lookup(attributes.__cssRef) });
      delete next.__cssRef;
      return next;
    });
  }

  root.extractCssAssets = extractCssAssets;
  root.rehydrateCssAssets = rehydrateCssAssets;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { extractCssAssets, rehydrateCssAssets };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
