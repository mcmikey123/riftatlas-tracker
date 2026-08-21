const test = require("node:test");
const assert = require("node:assert/strict");

const {
  toBase64Url,
  fromBase64Url,
  toLinkSeconds,
  fromLinkSeconds,
  toLinkSpeed,
  fromLinkSpeed,
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

/* The subtlety the whole helper exists for, and the one case where "no position"
 * and "the very beginning" are a single keystroke apart: 0 is a position and has
 * to reach the link as `.0`, where null, undefined and "" must add nothing. A
 * `Number(null)` slipping through anywhere in that chain turns every link built
 * without a timestamp into one pinned to 0:00. */
test("zero is a position and rides as .0, not as no timestamp", () => {
  const link = buildLink({ endpoint: ENDPOINT, objectId: OBJECT_ID, keyBytes: KEY, atSeconds: 0 });
  assert.strictEqual(link, `${ENDPOINT}/#1.${OBJECT_ID}.${toBase64Url(KEY)}.0`);
  assert.strictEqual(parseLink(link).atSeconds, 0);
  // The same round trip from the millisecond end, which is where it comes from.
  assert.strictEqual(
    buildLink({ endpoint: ENDPOINT, objectId: OBJECT_ID, keyBytes: KEY, atSeconds: toLinkSeconds(0) }),
    link,
    "a replay parked at the start must still name the moment it was shared at"
  );
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
  for (const bad of ["5.5", "1.5", "5.x", "5..x"]) {
    assert.throws(
      () => parseLink(`#1.${OBJECT_ID}.${toBase64Url(KEY)}.${bad}`),
      { name: "ShareLinkError", message: /malformed/ },
      `expected refusal for ${bad}`
    );
  }
});

/* A link pasted at the end of a sentence comes back with the full stop attached.
 * On a three-part link that stop was already harmless - it made an empty fourth
 * field, which reads as "no timestamp" - and leniency that stopped one character
 * short of the timestamped form would have cost the recipient the whole share
 * for the same typing. */
test("a full stop after the link costs the timestamp nothing, timestamped or not", () => {
  const key = toBase64Url(KEY);
  const timed = parseLink(`#1.${OBJECT_ID}.${key}.95.`);
  assert.strictEqual(timed.objectId, OBJECT_ID);
  assert.strictEqual(timed.atSeconds, 95, "the trailing stop must not become a fifth field");

  const plain = parseLink(`#1.${OBJECT_ID}.${key}.`);
  assert.strictEqual(plain.objectId, OBJECT_ID);
  assert.strictEqual(plain.atSeconds, null);
});

// Exactly one trailing stop is forgiven, and only behind a field that is really
// there. A fifth field with content in it means something rewrote the link.
test("only one trailing empty field is forgiven", () => {
  const key = toBase64Url(KEY);
  assert.strictEqual(parseLink(`#1.${OBJECT_ID}.${key}..`).atSeconds, null, "'..' is no timestamp");
  assert.throws(() => parseLink(`#1.${OBJECT_ID}.${key}.95..`), { name: "ShareLinkError" });
  // A missing key is not a stray full stop, however alike they look.
  assert.throws(() => parseLink(`#1.${OBJECT_ID}.`), { name: "ShareLinkError" });
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

// ---- the optional playback-speed field ----------------------------------

const FRAG = `${ENDPOINT}/#1.${OBJECT_ID}.${toBase64Url(KEY)}`;
const build = (extra) => buildLink({ endpoint: ENDPOINT, objectId: OBJECT_ID, keyBytes: KEY, ...extra });

/* 1x is the rate a viewer plays at when told nothing, so writing it would make
 * every ordinary link longer to say what already happens - and every link built
 * by the shares list, which passes no rate at all, must stay byte-for-byte what
 * it was. Both are the same guarantee from two directions. */
test("a link says nothing about speed at 1x, or when handed nothing readable", () => {
  assert.strictEqual(build({}), FRAG);
  for (const quiet of [undefined, null, "", 1, "1", 1.0, 0, -2, NaN, Infinity, "fast"]) {
    assert.strictEqual(
      build({ atSpeed: quiet }),
      FRAG,
      `atSpeed ${JSON.stringify(String(quiet))} must add nothing`
    );
  }
});

test("a speed rides as tenths behind an s, because 0.5 would be two fields", () => {
  // The separator is ".", so the rate cannot be written as the number it is.
  for (const [speed, field] of [[0.5, "s5"], [2, "s20"], [4, "s40"], [6, "s60"]]) {
    const link = build({ atSpeed: speed });
    assert.strictEqual(link, `${FRAG}.${field}`, `${speed}x must ride as ${field}`);
    assert.ok(!link.includes(".5."), "a rate must never put a bare decimal in the fragment");
    assert.strictEqual(fromLinkSpeed(parseLink(link).atSpeed), speed);
    assert.ok(link.length < 120, "links must stay short enough to paste anywhere");
  }
});

test("a moment and a rate ride together, and each survives without the other", () => {
  const both = build({ atSeconds: 95, atSpeed: 2 });
  assert.strictEqual(both, `${FRAG}.95.s20`);
  assert.deepStrictEqual(
    { at: parseLink(both).atSeconds, speed: fromLinkSpeed(parseLink(both).atSpeed) },
    { at: 95, speed: 2 }
  );

  // A rate with no moment needs no empty slot where the seconds would have been.
  const speedOnly = build({ atSpeed: 0.5 });
  assert.strictEqual(speedOnly, `${FRAG}.s5`);
  assert.strictEqual(parseLink(speedOnly).atSeconds, null, "no moment means no moment");
  assert.strictEqual(fromLinkSpeed(parseLink(speedOnly).atSpeed), 0.5);

  const momentOnly = build({ atSeconds: 95 });
  assert.strictEqual(momentOnly, `${FRAG}.95`);
  assert.strictEqual(parseLink(momentOnly).atSpeed, null, "no rate means no rate");
});

/* The fields are read by shape rather than by position precisely so that a chat
 * client, a mail wrapper or a person retyping a link cannot cost the recipient
 * the share by reordering two things that look interchangeable. */
test("the trailing fields parse in either order", () => {
  const forward = parseLink(`${FRAG}.95.s20`);
  const reversed = parseLink(`${FRAG}.s20.95`);
  assert.deepStrictEqual(
    { at: reversed.atSeconds, speed: reversed.atSpeed },
    { at: forward.atSeconds, speed: forward.atSpeed },
    "the order two optional fields arrive in must not change what they mean"
  );
});

/* Same guarantee the timestamp field already had: a link that ended a sentence
 * brings the full stop, and that must stay harmless now there is one more field
 * it could be mistaken for. */
test("a full stop after a rate is dropped, not read as a field", () => {
  assert.strictEqual(fromLinkSpeed(parseLink(`${FRAG}.s20.`).atSpeed), 2);
  assert.strictEqual(parseLink(`${FRAG}.95.s20.`).atSeconds, 95);
});

test("a rate that is not s-then-digits reads as no rate, never as a broken link", () => {
  for (const junk of ["sx", "s", "s-2", "s2x", "S20"]) {
    const parsed = parseLink(`${FRAG}.${junk}`);
    assert.strictEqual(parsed.atSpeed, null, `${junk} must not parse as a rate`);
  }
});

/* Two of a kind, or a sixth field, is a link that was rewritten rather than one
 * that was extended - and a rewritten link cannot be decrypted, so saying so is
 * the honest answer rather than opening something that will fail later. */
test("a repeated field or a sixth field is malformed, not a future format", () => {
  for (const bad of [`${FRAG}.95.96.s20`, `${FRAG}.s20.s40`, `${FRAG}.95.s20.s40`]) {
    assert.throws(() => parseLink(bad), /malformed/, `${bad} must be rejected`);
  }
});

test("toLinkSpeed rounds rather than truncates, so 0.5 cannot become 0.4", () => {
  assert.strictEqual(toLinkSpeed(0.49999999999999994), 5);
  assert.strictEqual(toLinkSpeed(2.0000000000000004), 20);
  assert.strictEqual(toLinkSpeed(1), null, "1x is the default and says nothing");
  assert.strictEqual(fromLinkSpeed(5), 0.5);
  assert.strictEqual(fromLinkSpeed(0), null);
  assert.strictEqual(fromLinkSpeed(undefined), null);
});

// The viewer is a web page a recipient may already have open, so every link
// shape that predates this field has to keep meaning exactly what it meant.
test("links that predate the speed field still parse, and report no rate", () => {
  assert.strictEqual(parseLink(FRAG).atSpeed, null);
  assert.strictEqual(parseLink(`${FRAG}.95`).atSpeed, null);
  assert.strictEqual(parseLink(`${FRAG}.0`).atSeconds, 0, "zero is still a position");
});

// ---- the optional game field (series shares) ---------------------------

const GAME_HOSTS = require("../share/hosts.js");
const GK = "A".repeat(43); // a well-formed base64url key field
const GOID = "B".repeat(22);

test("a series link carries a game field, in any order with the others", () => {
  const gameOnly = GAME_HOSTS.parseLink(`https://host/#1.${GOID}.${GK}.g2`);
  assert.equal(gameOnly.atGame, 2);
  assert.equal(gameOnly.atSeconds, null);

  const all3 = GAME_HOSTS.parseLink(`https://host/#1.${GOID}.${GK}.75.s20.g3`);
  assert.equal(all3.atSeconds, 75);
  assert.equal(all3.atSpeed, 20);
  assert.equal(all3.atGame, 3);

  // Chat clients reflow links; the order must not matter.
  const swapped = GAME_HOSTS.parseLink(`https://host/#1.${GOID}.${GK}.g3.s20.75`);
  assert.equal(swapped.atSeconds, 75);
  assert.equal(swapped.atSpeed, 20);
  assert.equal(swapped.atGame, 3);
});

test("a plain link still parses exactly as before, with no game", () => {
  const parsed = GAME_HOSTS.parseLink(`https://host/#1.${GOID}.${GK}.12`);
  assert.equal(parsed.atSeconds, 12);
  assert.equal(parsed.atGame, null);
});

test("a seventh field, or two game fields, is a mangled link", () => {
  for (const frag of [`1.${GOID}.${GK}.12.g2.g3`, `1.${GOID}.${GK}.12.s20.g2.9`]) {
    assert.throws(() => GAME_HOSTS.parseLink("https://host/#" + frag), /malformed/);
  }
});

test("a mangled game field reads as no game, never as a broken link", () => {
  // Same posture as the other trailing fields: it is a convenience, and
  // losing it must not cost the recipient the share.
  for (const field of ["g", "g-1", "gx", "G2"]) {
    assert.equal(GAME_HOSTS.parseLinkGame(field), null);
  }
});

test("buildLink appends the game only when one is named, after the others", () => {
  const keyBytes = new Uint8Array(32);
  const base = { endpoint: "https://host", objectId: GOID, keyBytes };
  assert.ok(!GAME_HOSTS.buildLink(base).includes(".g"));
  assert.ok(GAME_HOSTS.buildLink({ ...base, atGame: 2 }).endsWith(".g2"));
  const link = GAME_HOSTS.buildLink({ ...base, atSeconds: 9, atSpeed: 2, atGame: 2 });
  assert.ok(link.endsWith(".9.s20.g2"));
  const roundTrip = GAME_HOSTS.parseLink(link);
  assert.equal(roundTrip.atSeconds, 9);
  assert.equal(roundTrip.atSpeed, 20);
  assert.equal(roundTrip.atGame, 2);
});
