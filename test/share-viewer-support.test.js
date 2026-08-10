const test = require("node:test");
const assert = require("node:assert/strict");

const support = require("../share/viewer-support.js");
const { extractCssAssets, rehydrateCssAssets } = require("../store/css-assets.js");
const { ShareFormatError, ShareTruncatedError } = require("../share/payload.js");
const { ShareLinkError } = require("../share/hosts.js");

const BIG_CSS = ".big{color:red}".padEnd(5000, "/*x*/");
const OTHER_CSS = ".other{color:lime}".padEnd(5000, "/*y*/");
const hash = async (t) => "h" + t.length + t.slice(1, 4);

// A stylesheet node three levels deep, as rrweb actually emits it.
function fullSnapshot(cssText, baseId) {
  return {
    type: 2,
    timestamp: 1000 + baseId,
    data: {
      node: {
        type: 0,
        id: baseId,
        childNodes: [
          {
            type: 2,
            tagName: "html",
            attributes: { lang: "en" },
            id: baseId + 1,
            childNodes: [
              {
                type: 2,
                tagName: "head",
                attributes: {},
                id: baseId + 2,
                childNodes: [
                  {
                    type: 2,
                    tagName: "link",
                    attributes: { rel: "stylesheet", href: "/s.css", _cssText: cssText },
                    id: baseId + 3,
                    childNodes: []
                  }
                ]
              }
            ]
          }
        ]
      }
    }
  };
}

// Two snapshots carrying the same sheet plus one carrying a second sheet: the
// real shape, where rrweb repeats every stylesheet on every keyframe.
const stripped = () =>
  extractCssAssets(
    [
      { type: 4, timestamp: 999, data: { href: "https://example.test/", width: 1280, height: 800 } },
      fullSnapshot(BIG_CSS, 10),
      fullSnapshot(BIG_CSS, 20),
      fullSnapshot(OTHER_CSS, 30)
    ],
    { hash }
  );

test("collects each distinct stylesheet ref once", async () => {
  const { events } = await stripped();
  assert.equal(support.cssRefsIn(events).length, 2);
});

test("a Map built from the payload's assets resolves every ref", async () => {
  const { events, assets } = await stripped();
  const fromJson = new Map(Object.entries(Object.fromEntries(assets)));

  assert.deepEqual(support.unresolvedCssRefs(events, fromJson), []);
  assert.equal(support.emptyCssTextCount(rehydrateCssAssets(events, fromJson)), 0);
});

// The silent failure this whole guard exists for: rehydrateCssAssets neither
// throws nor warns on a plain object, it just resolves every ref to "", and
// rrweb then leaves the <link> unstyled because "" is falsy.
test("a plain object instead of a Map reports every ref unresolved", async () => {
  const { events, assets } = await stripped();
  const plain = Object.fromEntries(assets);

  assert.equal(support.unresolvedCssRefs(events, plain).length, 2);
  assert.equal(support.emptyCssTextCount(rehydrateCssAssets(events, plain)), 3);
});

test("an absent or empty asset is unresolved", async () => {
  const { events, assets } = await stripped();
  const refs = support.cssRefsIn(events);

  const dropped = new Map(assets);
  dropped.delete(refs[0]);
  assert.deepEqual(support.unresolvedCssRefs(events, dropped), [refs[0]]);

  const emptied = new Map(assets);
  emptied.set(refs[0], "");
  assert.deepEqual(support.unresolvedCssRefs(events, emptied), [refs[0]]);
});

test("events with no refs need no assets at all", () => {
  const events = [{ type: 3, timestamp: 1, data: { source: 3, id: 9, x: 0, y: 12 } }];
  assert.deepEqual(support.unresolvedCssRefs(events, undefined), []);
  assert.equal(support.emptyCssTextCount(events), 0);
});

test("each named failure earns its own message", () => {
  const cases = [
    [new ShareLinkError("no fragment"), "This link is malformed."],
    [Object.assign(new Error("bad tag"), { name: "OperationError" }), "This link is incomplete or was altered."],
    [new ShareFormatError("bad magic"), "This isn't a valid replay file."],
    [new ShareTruncatedError("short"), "This isn't a valid replay file."],
    [new support.ViewerError("missing"), "This share has expired or was never uploaded."],
    [new support.ViewerError("css"), "This replay is missing its stylesheets."]
  ];
  for (const [err, message] of cases) {
    assert.equal(support.describeFailure(err).message, message, err.name + " " + (err.kind || ""));
  }
});

test("only transport failures offer a retry", () => {
  assert.equal(support.describeFailure(new support.ViewerError("network")).retry, true);
  assert.equal(support.describeFailure(new support.ViewerError("server")).retry, true);
  assert.equal(support.describeFailure(new support.ViewerError("missing")).retry, false);
  assert.equal(support.describeFailure(new ShareLinkError("x")).retry, false);
});

test("an unrecognised failure takes the caller's fallback, then unknown", () => {
  const odd = new TypeError("something else entirely");
  assert.equal(support.describeFailure(odd, "format").kind, "format");
  assert.equal(support.describeFailure(odd).kind, "unknown");
  // A kind the message table does not know is not trusted just because it is set.
  assert.equal(support.describeFailure(Object.assign(new Error("x"), { kind: "nonsense" })).kind, "unknown");
});

test("only finished, empty, card-art images count as broken", () => {
  const cdn = "https://assets.riftatlas-workers.com";
  const images = [
    { complete: true, naturalWidth: 0, src: cdn + "/card/1.png" }, // broken
    { complete: true, naturalWidth: 0, src: cdn + "/card/2.png" }, // broken
    { complete: true, naturalWidth: 64, src: cdn + "/card/3.png" }, // loaded
    { complete: false, naturalWidth: 0, src: cdn + "/card/4.png" }, // still loading
    { complete: true, naturalWidth: 0, src: "data:image/png;base64,AAAA" } // not the CDN
  ];
  assert.equal(support.brokenImages(images, cdn), 2);
  assert.equal(support.brokenImages([], cdn), 0);
  assert.equal(support.brokenImages(null, cdn), 0);
});

test("the clock reads m:ss and never goes backwards past zero", () => {
  assert.equal(support.fmtClock(0), "0:00");
  assert.equal(support.fmtClock(9500), "0:10");
  assert.equal(support.fmtClock(605000), "10:05");
  assert.equal(support.fmtClock(-50), "0:00");
  assert.equal(support.fmtClock(NaN), "0:00");
});
