const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_UPLOAD_BYTES,
  SHARE_TTL_MS,
  MESSAGES,
  fmtSize,
  checkPayloadSize,
  describeUploadFailure,
  hasShareMagic,
  shareRecord,
  expiresAt
} = require("../share/share-ui-support.js");

const { buildSharePayload, generateKey } = require("../share/payload.js");

test("the cap matches the one the worker config declares", () => {
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
