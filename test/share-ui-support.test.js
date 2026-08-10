const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_UPLOAD_BYTES,
  SHARE_TTL_MS,
  MESSAGES,
  RECHECK_MESSAGES,
  fmtSize,
  checkPayloadSize,
  describeUploadFailure,
  hasShareMagic,
  shareRecord,
  expiresAt,
  isExpired,
  expiryText,
  readShareList,
  describeRecheck
} = require("../share/share-ui-support.js");

const { buildSharePayload, generateKey } = require("../share/payload.js");

// That this is the same number the Worker is configured with is asserted against
// wrangler.toml.example in test/worker-headers.test.js; here it only anchors the
// figure the design settled on, 3.4x the largest replay measured.
test("the cap is the 12 MB the design settled on", () => {
  assert.strictEqual(MAX_UPLOAD_BYTES, 12582912);
});

test("sizes read as bytes, kilobytes and megabytes", () => {
  assert.strictEqual(fmtSize(0), "0 B");
  assert.strictEqual(fmtSize(512), "512 B");
  assert.strictEqual(fmtSize(1536), "1.5 KB");
  assert.strictEqual(fmtSize(3644834), "3.48 MB");
  assert.strictEqual(fmtSize(undefined), "an unknown size");
});

test("a frame inside the cap is accepted with its real size", () => {
  assert.deepStrictEqual(checkPayloadSize(3644834, MAX_UPLOAD_BYTES), {
    ok: true,
    bytes: 3644834,
    limit: MAX_UPLOAD_BYTES
  });
});

test("exactly the cap is allowed, one byte over is refused with both figures", () => {
  assert.strictEqual(checkPayloadSize(MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES).ok, true);
  const over = checkPayloadSize(MAX_UPLOAD_BYTES + 1, MAX_UPLOAD_BYTES);
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.kind, "tooLarge");
  assert.match(over.message, /12\.00 MB/);
  assert.match(over.message, /can't be shared/);
});

test("an empty or unmeasurable frame is refused rather than uploaded", () => {
  for (const bad of [0, -1, NaN, undefined, null, "big"]) {
    assert.strictEqual(checkPayloadSize(bad, MAX_UPLOAD_BYTES).ok, false, String(bad));
  }
});

// The cap is the only thing standing between a runaway replay and a PUT that
// fails after ~600 ms of work. A broken cap must never read as "no cap".
test("a missing or unparseable cap fails closed, never open", () => {
  for (const badCap of [undefined, null, 0, -1, NaN, "twelve"]) {
    const result = checkPayloadSize(100, badCap);
    assert.strictEqual(result.ok, false, `cap ${JSON.stringify(badCap)} must not be accepted`);
    assert.strictEqual(result.kind, "misconfigured");
  }
});

test("each upload status earns its own message and its own retryability", () => {
  const cases = [
    [403, "rejected", false],
    [411, "rejected", false],
    [413, "tooLarge", false],
    [429, "rateLimited", true],
    [500, "misconfigured", false],
    [503, "unavailable", true]
  ];
  for (const [status, kind, retry] of cases) {
    const described = describeUploadFailure(Object.assign(new Error("x"), { status }));
    assert.strictEqual(described.kind, kind, `status ${status}`);
    assert.strictEqual(described.message, MESSAGES[kind], `status ${status}`);
    assert.strictEqual(described.retry, retry, `status ${status}`);
  }
});

test("an unmapped status still lands on a sensible side of retryable", () => {
  assert.deepStrictEqual(describeUploadFailure(Object.assign(new Error("x"), { status: 418 })), {
    kind: "rejected",
    message: MESSAGES.rejected,
    retry: false
  });
  assert.strictEqual(describeUploadFailure(Object.assign(new Error("x"), { status: 502 })).kind, "unavailable");
});

// share/hosts.js only sets `.status` when the endpoint actually answered. A
// rejected fetch has none, and must not be reported as a refusal.
test("a transport failure with no status is a retryable network error", () => {
  for (const err of [new TypeError("Failed to fetch"), {}, null, undefined]) {
    const described = describeUploadFailure(err);
    assert.strictEqual(described.kind, "network");
    assert.strictEqual(described.retry, true);
  }
});

test("the four distinct messages are actually distinct", () => {
  const shown = Object.values(MESSAGES);
  assert.strictEqual(new Set(shown).size, shown.length, "every failure needs its own wording");
});

test("the magic check accepts a real frame and rejects an HTML interstitial", async () => {
  const key = await generateKey({});
  const frame = await buildSharePayload({ meta: {}, events: [], assets: {} }, key, {});
  assert.strictEqual(hasShareMagic(frame), true);
  assert.strictEqual(hasShareMagic(frame.subarray(0, 4)), true);

  const html = new TextEncoder().encode("<!doctype html><title>Please wait…</title>");
  assert.strictEqual(hasShareMagic(html), false);
  assert.strictEqual(hasShareMagic(new Uint8Array([0x52, 0x41, 0x52])), false, "short reads must not pass");
  assert.strictEqual(hasShareMagic(new Uint8Array(0)), false);
  assert.strictEqual(hasShareMagic(null), false);
});

// Task 8 reads these records back to list and re-check shares. Every field is
// load-bearing, and the key most of all: it exists nowhere else in the world.
test("a share record keeps exactly the fields a link can be rebuilt from", () => {
  const record = shareRecord({
    matchId: "m1",
    objectId: "AAAAAAAAAAAAAAAAAAAAAA",
    key: "B".repeat(43),
    endpoint: "https://share.example.workers.dev/",
    createdAt: 1770000000000
  });
  assert.deepStrictEqual(record, {
    matchId: "m1",
    objectId: "AAAAAAAAAAAAAAAAAAAAAA",
    key: "B".repeat(43),
    endpoint: "https://share.example.workers.dev",
    createdAt: 1770000000000
  });
});

test("a record missing any field is refused rather than stored half-built", () => {
  const good = {
    matchId: "m1",
    objectId: "AAAAAAAAAAAAAAAAAAAAAA",
    key: "B".repeat(43),
    endpoint: "https://share.example.workers.dev",
    createdAt: 1770000000000
  };
  for (const field of Object.keys(good)) {
    const broken = Object.assign({}, good);
    delete broken[field];
    assert.throws(() => shareRecord(broken), new RegExp(field === "createdAt" ? "createdAt" : field));
  }
  assert.throws(() => shareRecord(Object.assign({}, good, { createdAt: 0 })), /createdAt/);
});

test("a share expires seven days after it was created", () => {
  const created = 1770000000000;
  assert.strictEqual(SHARE_TTL_MS, 604800000);
  assert.strictEqual(expiresAt({ createdAt: created }), created + 604800000);
});

// ---- the shares list -----------------------------------------------------

const CREATED = 1770000000000;
const HOUR = 3600000;
const record = (over) =>
  Object.assign(
    {
      matchId: "m1",
      objectId: "A".repeat(22),
      key: "B".repeat(43),
      endpoint: "https://share.example.workers.dev",
      createdAt: CREATED
    },
    over
  );

test("expiry is reached at the TTL, not a moment before", () => {
  const r = record();
  assert.strictEqual(isExpired(r, expiresAt(r) - 1), false);
  assert.strictEqual(isExpired(r, expiresAt(r)), true);
  assert.strictEqual(isExpired(r, expiresAt(r) + HOUR), true);
});

// Never round up: "in 6 days" on a share with 6.9 days left is honest, while
// "in 7 days" on one with 6.1 days left promises time the bucket will not give.
test("time left reads in the largest unit that is not an overstatement", () => {
  const at = (msLeft) => expiryText(record(), expiresAt(record()) - msLeft);
  assert.strictEqual(at(7 * 24 * HOUR), "in 7 days");
  assert.strictEqual(at(6.9 * 24 * HOUR), "in 6 days");
  assert.strictEqual(at(47 * HOUR), "in 1 day");
  assert.strictEqual(at(23.5 * HOUR), "in 23 hours");
  assert.strictEqual(at(1.5 * HOUR), "in 1 hour");
  assert.strictEqual(at(90000), "in 1 minute");
  assert.strictEqual(at(20000), "in under a minute");
});

test("a share past its TTL says so, and says how long ago", () => {
  const r = record();
  assert.strictEqual(expiryText(r, expiresAt(r)), "expired just now");
  assert.strictEqual(expiryText(r, expiresAt(r) + 2 * HOUR), "expired 2 hours ago");
  assert.strictEqual(expiryText(r, expiresAt(r) + 50 * HOUR), "expired 2 days ago");
});

test("the stored list comes back newest first", () => {
  const rows = readShareList([
    record({ objectId: "A".repeat(22), createdAt: CREATED }),
    record({ objectId: "C".repeat(22), createdAt: CREATED + 2 * HOUR }),
    record({ objectId: "B".repeat(22), createdAt: CREATED + HOUR })
  ]);
  assert.deepStrictEqual(
    rows.map((r) => r.objectId),
    ["C".repeat(22), "B".repeat(22), "A".repeat(22)]
  );
});

// A row whose link cannot be rebuilt is worse than no row: it claims a share
// exists and offers no way to reach it. The key and the object id are the two
// fields the link is made of, so both are checked for shape, not just presence.
test("entries that could never produce a link are dropped, not rendered", () => {
  const rows = readShareList([
    record(),
    null,
    "nonsense",
    record({ key: "" }),
    record({ key: "B".repeat(42) }),
    record({ key: "B".repeat(43).replace("B", "+") }),
    record({ objectId: "A".repeat(21) }),
    record({ objectId: "A".repeat(22).replace("A", "/") }),
    record({ createdAt: 0 })
  ]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].endpoint, "https://share.example.workers.dev");
});

test("a missing or non-array shares key reads as no shares", () => {
  for (const bad of [undefined, null, {}, "shares", 7]) {
    assert.deepStrictEqual(readShareList(bad), [], String(bad));
  }
});

// The three outcomes need three different reactions from the reader: the link
// works, the link is dead, or nothing was learned. Collapsing "unreachable"
// into "gone" would tell someone a share had expired when it had not.
test("a re-check separates alive, gone and learned-nothing", () => {
  const alive = describeRecheck({ reached: true, status: 200, magic: true });
  assert.strictEqual(alive.state, "alive");
  assert.strictEqual(alive.message, RECHECK_MESSAGES.alive);

  assert.strictEqual(describeRecheck({ reached: true, status: 206, magic: true }).state, "alive");
  assert.strictEqual(describeRecheck({ reached: true, status: 404 }).state, "gone");
  assert.strictEqual(describeRecheck({ reached: true, status: 404 }).message, RECHECK_MESSAGES.gone);
  assert.strictEqual(describeRecheck({ reached: false }).state, "unreachable");
  assert.strictEqual(describeRecheck({ reached: false }).message, RECHECK_MESSAGES.unreachable);
  assert.strictEqual(describeRecheck({}).state, "unreachable");
});

// The failure the post-upload check exists to catch: a 200 carrying an HTML
// interstitial rather than the object. It is not proof the share is gone.
test("a 200 that is not a share frame is not reported as alive or as gone", () => {
  const odd = describeRecheck({ reached: true, status: 200, magic: false });
  assert.strictEqual(odd.state, "unreachable");
  assert.strictEqual(odd.message, RECHECK_MESSAGES.unexpected);
});

test("an unexpected status names itself so the number is not lost", () => {
  const busy = describeRecheck({ reached: true, status: 503 });
  assert.strictEqual(busy.state, "unreachable");
  assert.match(busy.message, /503/);
});

test("every re-check outcome carries a short label and a distinct message", () => {
  const outcomes = [
    { reached: true, status: 200, magic: true },
    { reached: true, status: 404 },
    { reached: true, status: 200, magic: false },
    { reached: false }
  ].map(describeRecheck);
  for (const o of outcomes) {
    assert.ok(o.label && o.label.length < 20, `a pill needs a short label, got ${o.label}`);
    assert.ok(o.message, "every outcome needs a message");
  }
  const messages = outcomes.map((o) => o.message);
  assert.strictEqual(new Set(messages).size, messages.length, "outcomes must not share wording");
});
