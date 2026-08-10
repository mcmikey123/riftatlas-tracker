const test = require("node:test");
const assert = require("node:assert/strict");

const {
  toBase64Url,
  fromBase64Url,
  toLinkSeconds,
  fromLinkSeconds,
  buildLink,
  parseLink,
  hostFor
} = require("../share/hosts.js");

const KEY = new Uint8Array(32).fill(7);
const ENDPOINT = "https://share.example.workers.dev";
const OBJECT_ID = "AAAAAAAAAAAAAAAAAAAAAA";

test("base64url round-trips and uses no padding or unsafe characters", () => {
  const encoded = toBase64Url(KEY);
  assert.strictEqual(encoded.length, 43);
  assert.ok(!/[+/=]/.test(encoded));
  assert.deepStrictEqual([...fromBase64Url(encoded)], [...KEY]);
});

test("a link carries version, object id and key in the fragment", () => {
  const link = buildLink({ endpoint: ENDPOINT, objectId: OBJECT_ID, keyBytes: KEY });
  assert.strictEqual(link, `${ENDPOINT}/#1.${OBJECT_ID}.${toBase64Url(KEY)}`);
  assert.ok(link.length < 120, "links must stay short enough to paste anywhere");
});

test("a link round-trips through parseLink", () => {
  const link = buildLink({ endpoint: ENDPOINT, objectId: OBJECT_ID, keyBytes: KEY });
  const parsed = parseLink(link);
  assert.strictEqual(parsed.version, "1");
  assert.strictEqual(parsed.objectId, OBJECT_ID);
  assert.deepStrictEqual([...parsed.keyBytes], [...KEY]);
});

test("a bare fragment parses the same as a full link", () => {
  const parsed = parseLink(`#1.${OBJECT_ID}.${toBase64Url(KEY)}`);
  assert.strictEqual(parsed.objectId, OBJECT_ID);
});

test("a trailing slash on the endpoint does not double up", () => {
  const link = buildLink({ endpoint: `${ENDPOINT}/`, objectId: OBJECT_ID, keyBytes: KEY });
  assert.ok(!link.includes("//#"));
});

test("an unknown link version is refused by name", () => {
  assert.throws(() => parseLink(`#9.${OBJECT_ID}.${toBase64Url(KEY)}`), {
    name: "ShareLinkError",
    message: /newer/
  });
});

test("malformed fragments are refused rather than half-parsed", () => {
  for (const bad of ["", "#", "#1", `#1.${OBJECT_ID}`, "#1..", `#1.${OBJECT_ID}.`, "#1.a.b.c"]) {
    assert.throws(() => parseLink(bad), { name: "ShareLinkError" }, `expected refusal for ${bad}`);
  }
});

test("a key of the wrong length is refused", () => {
  assert.throws(() => parseLink(`#1.${OBJECT_ID}.${toBase64Url(new Uint8Array(16))}`), {
    name: "ShareLinkError",
    message: /key/
  });
});

// A key whose length is 1 mod 4 is not decodable base64 at all. Decoding before checking
// the length let atob throw a raw DOMException, which escapes this file's error taxonomy —
// and the viewer switches on that taxonomy to pick which of four remedies to show.
test("an undecodable key length raises ShareLinkError, never a DOMException", () => {
  for (const length of [1, 5, 41, 42, 44, 45]) {
    let thrown;
    try {
      parseLink(`#1.${OBJECT_ID}.${"A".repeat(length)}`);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, `key length ${length} must be refused`);
    assert.strictEqual(thrown.name, "ShareLinkError", `key length ${length} threw ${thrown.name}`);
  }
});

// ---- the optional playback-position field -------------------------------

test("a link without a timestamp is byte-for-byte what it always was", () => {
  const before = `${ENDPOINT}/#1.${OBJECT_ID}.${toBase64Url(KEY)}`;
  assert.strictEqual(buildLink({ endpoint: ENDPOINT, objectId: OBJECT_ID, keyBytes: KEY }), before);
  for (const absent of [undefined, null, ""]) {
    assert.strictEqual(
      buildLink({ endpoint: ENDPOINT, objectId: OBJECT_ID, keyBytes: KEY, atSeconds: absent }),
      before,
      `atSeconds ${JSON.stringify(absent)} must add nothing`
    );
  }
});

test("a timestamp rides as a fourth fragment field in whole seconds", () => {
  const link = buildLink({ endpoint: ENDPOINT, objectId: OBJECT_ID, keyBytes: KEY, atSeconds: 95 });
  assert.strictEqual(link, `${ENDPOINT}/#1.${OBJECT_ID}.${toBase64Url(KEY)}.95`);
  assert.ok(link.length < 120, "links must stay short enough to paste anywhere");
  assert.strictEqual(parseLink(link).atSeconds, 95);
});

// Real three-part links are in the wild and their recipients have not upgraded
// anything - the viewer is a web page they may already have open.
test("an existing three-part link still parses, and reports no timestamp", () => {
  const parsed = parseLink(`#1.${OBJECT_ID}.${toBase64Url(KEY)}`);
  assert.strictEqual(parsed.objectId, OBJECT_ID);
  assert.deepStrictEqual([...parsed.keyBytes], [...KEY]);
  assert.strictEqual(parsed.atSeconds, null);
});

// A timestamp is a convenience; the replay plays perfectly without it. A field
// mangled by a chat client must therefore cost the recipient the timestamp, and
// never the whole share.
test("an unusable timestamp reads as no timestamp rather than a broken link", () => {
  for (const bad of ["", "-5", "abc", "5s", " 5", "1e3", "007x", "9".repeat(30)]) {
    const parsed = parseLink(`#1.${OBJECT_ID}.${toBase64Url(KEY)}.${bad}`);
    assert.strictEqual(parsed.objectId, OBJECT_ID, `objectId lost for ${JSON.stringify(bad)}`);
    assert.strictEqual(parsed.atSeconds, null, `expected no timestamp for ${JSON.stringify(bad)}`);
  }
});

// A dot is the field separator, so "1.5" is not a fourth field, it is a fourth
// and a fifth. Nothing this project builds emits one - the field is whole
// seconds by construction - so five fields means something rewrote the link,
// and "check the whole link was copied" is the honest remedy for that.
test("extra fields are a mangled link, not a future format", () => {
  for (const bad of ["5.5", "1.5", "5.", "5.x"]) {
    assert.throws(
      () => parseLink(`#1.${OBJECT_ID}.${toBase64Url(KEY)}.${bad}`),
      { name: "ShareLinkError", message: /malformed/ },
      `expected refusal for ${bad}`
    );
  }
});

// The key is checked before the timestamp is looked at, so the one failure that
// actually loses the replay is still reported as itself.
test("a bad key is still refused when a timestamp is present", () => {
  assert.throws(() => parseLink(`#1.${OBJECT_ID}.tooshort.42`), {
    name: "ShareLinkError",
    message: /key/
  });
});

test("milliseconds become whole seconds, floored, and back again", () => {
  assert.strictEqual(toLinkSeconds(0), 0);
  assert.strictEqual(toLinkSeconds(999), 0);
  assert.strictEqual(toLinkSeconds(1000), 1);
  // Floored, never rounded: rounding up names a moment the sharer had not
  // reached when they pressed the button.
  assert.strictEqual(toLinkSeconds(1999), 1);
  assert.strictEqual(fromLinkSeconds(95), 95000);
  assert.strictEqual(fromLinkSeconds(0), 0);
});

test("an unusable position produces no timestamp in either direction", () => {
  for (const bad of [undefined, null, NaN, Infinity, -1, "later"]) {
    assert.strictEqual(toLinkSeconds(bad), null, `toLinkSeconds(${String(bad)})`);
    assert.strictEqual(fromLinkSeconds(bad), null, `fromLinkSeconds(${String(bad)})`);
  }
});

// The whole reason the position is a fragment field rather than ?t=: this is
// what a URL looks like after someone edits one by hand, and it must not be
// swallowed into the key and reported as a decryption failure.
test("a querystring pasted after the fragment does not silently corrupt the key", () => {
  assert.throws(() => parseLink(`${ENDPOINT}/#1.${OBJECT_ID}.${toBase64Url(KEY)}?t=5000`), {
    name: "ShareLinkError",
    message: /key/
  });
});

test("the worker uploader posts the token and returns the object id", async () => {
  const calls = [];
  const id = await hostFor("w").upload(new Uint8Array([1, 2, 3]), {
    endpoint: `${ENDPOINT}/`,
    token: "tok",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ id: OBJECT_ID }) };
    }
  });
  assert.strictEqual(id, OBJECT_ID);
  assert.strictEqual(calls[0].url, `${ENDPOINT}/u`, "trailing slash must not double up");
  assert.strictEqual(calls[0].init.method, "PUT");
  assert.strictEqual(calls[0].init.headers["x-share-token"], "tok");
});

// The dashboard shows a different message per status - rate limited, too large, disabled -
// so the status has to survive the throw rather than collapsing into a generic failure.
test("an upload failure carries the HTTP status through", async () => {
  for (const status of [403, 413, 429, 503]) {
    await assert.rejects(
      () =>
        hostFor("w").upload(new Uint8Array([1]), {
          endpoint: ENDPOINT,
          token: "tok",
          fetch: async () => ({ ok: false, status })
        }),
      (err) => err.status === status && /upload failed/.test(err.message)
    );
  }
});

// A 200 whose body is not JSON used to throw a SyntaxError with no `.status`,
// which the dashboard maps to "check your connection" - about an endpoint that
// answered perfectly well.
test("a 200 that is not JSON is reported against the status it came with", async () => {
  await assert.rejects(
    () =>
      hostFor("w").upload(new Uint8Array([1]), {
        endpoint: ENDPOINT,
        token: "tok",
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token <");
          }
        })
      }),
    (err) => err.status === 200 && /isn't JSON/.test(err.message)
  );
});

// The id is interpolated into a link that is shown, stored and later re-read.
// The share list drops any record whose id is the wrong shape, and the record
// is the only place the decryption key exists - so a malformed id loses the key.
test("an object id that is not the link shape is refused rather than turned into a link", async () => {
  for (const id of [undefined, null, "", 42, "short", `${OBJECT_ID}A`, "AAAAAAAAAAAAAAAAAAAA/+"]) {
    await assert.rejects(
      () =>
        hostFor("w").upload(new Uint8Array([1]), {
          endpoint: ENDPOINT,
          token: "tok",
          fetch: async () => ({ ok: true, status: 200, json: async () => ({ id }) })
        }),
      (err) => err.status === 200 && /object id/.test(err.message),
      `expected refusal for ${JSON.stringify(id)}`
    );
  }
});

test("the worker host is registered and unknown ids are refused", () => {
  assert.strictEqual(hostFor("w").id, "w");
  assert.throws(() => hostFor("zz"), { name: "ShareLinkError" });
});
