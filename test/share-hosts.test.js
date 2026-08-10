const test = require("node:test");
const assert = require("node:assert/strict");

const {
  toBase64Url,
  fromBase64Url,
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
