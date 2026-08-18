"use strict";

/* A page the capture's DOM readers can be driven against.
 *
 * Not a DOM implementation and not trying to be one: there is no dependency to
 * add here (see standards/dependency-discipline.md) and a real one would only
 * be testing jsdom's selector engine. What the readers in capture/board-read.js,
 * capture/deck-cards.js, capture/deck-scan.js and capture/match-format.js
 * actually contain is traversal and parsing - which rail is yours, which score
 * node is the current one, which <span> in a log row is the time, which sibling
 * <p> is the legend - and all of that runs on whatever the selector handed back.
 *
 * So selectors are declared rather than matched: an element lists the selector
 * strings it answers to, and every ancestor indexes it in insertion order, i.e.
 * document order. A reader asking for a selector no element declared gets [],
 * exactly as it would on a page that does not have one.
 */

/**
 * @param {object} spec
 * @param {string} [spec.tag] - "div" by default; "P" is what the deck sweep
 *   compares against.
 * @param {string[]} [spec.sel] - the selector strings this element answers to.
 * @param {string} [spec.text] - its own text, before children.
 * @param {object} [spec.dataset] - data-* attributes as the readers see them.
 * @param {object} [spec.attrs] - anything read with getAttribute().
 * @param {Array} [spec.kids] - children, in document order.
 */
function el(spec = {}) {
  const node = {
    nodeType: 1,
    tagName: (spec.tag || "div").toUpperCase(),
    className: spec.className || "",
    dataset: Object.assign({}, spec.dataset),
    alt: spec.alt,
    src: spec.src,
    currentSrc: spec.currentSrc,
    parentElement: null,
    children: [],
    ownSelectors: spec.sel || [],
    index: new Map(), // selector -> descendants, document order
    attrs: Object.assign({}, spec.attrs),
    ownText: spec.text || "",
  };

  Object.defineProperty(node, "textContent", {
    get() {
      return node.ownText + node.children.map((k) => k.textContent).join("");
    },
  });

  node.getAttribute = (name) => (name in node.attrs ? node.attrs[name] : null);

  node.querySelectorAll = (selector) => (node.index.get(selector) || []).slice();
  node.querySelector = (selector) => (node.index.get(selector) || [])[0] || null;

  node.closest = (selector) => {
    let at = node;
    while (at) {
      if (at.ownSelectors.includes(selector)) return at;
      at = at.parentElement;
    }
    return null;
  };

  Object.defineProperty(node, "nextElementSibling", {
    get() {
      const siblings = node.parentElement ? node.parentElement.children : [];
      return siblings[siblings.indexOf(node) + 1] || null;
    },
  });

  for (const kid of spec.kids || []) append(node, kid);
  return node;
}

/** Adds a child and indexes it, and everything under it, on every ancestor. */
function append(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  for (let at = parent; at; at = at.parentElement) {
    for (const [selector, nodes] of child.index) {
      const into = at.index.get(selector) || [];
      at.index.set(selector, into.concat(nodes));
    }
    for (const selector of child.ownSelectors) {
      at.index.set(selector, (at.index.get(selector) || []).concat([child]));
    }
  }
  return parent;
}

/** A text node, as the mutation scan sees one. */
const text = (value, parentElement) => ({ nodeType: 3, textContent: value, parentElement });

module.exports = { el, append, text };
