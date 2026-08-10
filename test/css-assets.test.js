const test = require("node:test");
const assert = require("node:assert/strict");

const { extractCssAssets, rehydrateCssAssets } = require("../store/css-assets.js");

const BIG_CSS = ".big{color:red}".padEnd(5000, "/*x*/");
const SMALL_CSS = ".small{color:blue}".padEnd(100, " ");
const hash = async (t) => "h" + t.length;

// A realistic rrweb full-snapshot: the <style> and <link> nodes sit three
// levels deep, not at the top of the tree.
function fullSnapshot(cssText, baseId = 1) {
  const id = (n) => baseId + n;
  return {
    type: 2,
    timestamp: 1000 + baseId,
    data: {
      node: {
        type: 0,
        id: id(0),
        childNodes: [
          {
            type: 2,
            tagName: "html",
            attributes: { lang: "en" },
            id: id(1),
            childNodes: [
              {
                type: 2,
                tagName: "head",
                attributes: {},
                id: id(2),
                childNodes: [
                  {
                    type: 2,
                    tagName: "title",
                    attributes: {},
                    id: id(3),
                    childNodes: [{ type: 3, textContent: "Rift Atlas", id: id(4) }],
                  },
                  {
                    type: 2,
                    tagName: "style",
                    attributes: { _cssText: cssText },
                    id: id(5),
                    childNodes: [],
                  },
                  {
                    type: 2,
                    tagName: "link",
                    attributes: { rel: "stylesheet", href: "/s.css", _cssText: SMALL_CSS },
                    id: id(6),
                    childNodes: [],
                  },
                ],
              },
              {
                type: 2,
                tagName: "body",
                attributes: { class: "board" },
                id: id(7),
                childNodes: [{ type: 3, textContent: "hello", id: id(8) }],
              },
            ],
          },
        ],
      },
      initialOffset: { left: 0, top: 0 },
    },
  };
}

function makeEvents() {
  return [
    { type: 4, timestamp: 999, data: { href: "https://example.test/", width: 800, height: 600 } },
    fullSnapshot(BIG_CSS, 1),
    { type: 3, timestamp: 1100, data: { source: 3, id: 9, x: 0, y: 120 } },
  ];
}

function findById(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.childNodes || []) {
    const hit = findById(child, id);
    if (hit) return hit;
  }
  return null;
}

const nodeOf = (event) => event.data.node;

test("round-trips back to the original events", async () => {
  const input = makeEvents();
  const { events, assets } = await extractCssAssets(input, { hash });
  assert.deepEqual(rehydrateCssAssets(events, assets), input);
});

test("replaces oversized css text with a single ref and collects it once", async () => {
  const { events, assets } = await extractCssAssets(makeEvents(), { hash });
  const styleNode = findById(nodeOf(events[1]), 6);

  assert.equal(styleNode.attributes.__cssRef, "h" + BIG_CSS.length);
  assert.equal("_cssText" in styleNode.attributes, false);
  assert.equal(assets.size, 1);
  assert.equal(assets.get("h" + BIG_CSS.length), BIG_CSS);
});

test("leaves css text under minBytes inline and out of assets", async () => {
  const { events, assets } = await extractCssAssets(makeEvents(), { hash });
  const linkNode = findById(nodeOf(events[1]), 7);

  assert.equal(linkNode.attributes._cssText, SMALL_CSS);
  assert.equal("__cssRef" in linkNode.attributes, false);
  assert.equal([...assets.values()].includes(SMALL_CSS), false);
});

test("shares one asset entry between two snapshots with identical css", async () => {
  const input = [fullSnapshot(BIG_CSS, 1), fullSnapshot(BIG_CSS, 100)];
  const { events, assets } = await extractCssAssets(input, { hash });

  assert.equal(assets.size, 1);
  assert.equal(findById(nodeOf(events[0]), 6).attributes.__cssRef, "h" + BIG_CSS.length);
  assert.equal(findById(nodeOf(events[1]), 105).attributes.__cssRef, "h" + BIG_CSS.length);
  assert.deepEqual(rehydrateCssAssets(events, assets), input);
});

test("rehydrates an unknown ref to empty css text without throwing", async () => {
  const { events } = await extractCssAssets(makeEvents(), { hash });
  const rehydrated = rehydrateCssAssets(events, new Map());
  const styleNode = findById(nodeOf(rehydrated[1]), 6);

  assert.equal(styleNode.attributes._cssText, "");
  assert.equal("__cssRef" in styleNode.attributes, false);
});

test("does not mutate the input events", async () => {
  const input = makeEvents();
  const before = structuredClone(input);
  const { events } = await extractCssAssets(input, { hash });

  assert.deepEqual(input, before);
  assert.notEqual(events[1], input[1]);
  assert.equal(events[0], input[0]);
});
