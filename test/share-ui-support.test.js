const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_UPLOAD_BYTES,
  SHARE_TTL_MS,
  MESSAGES,
  RECHECK_MESSAGES,
  RECHECK_LABELS,
  fmtSize,
  checkPayloadSize,
  describeUploadFailure,
  hasShareMagic,
  shareRecord,
  expiresAt,
  isExpired,
  isPrunable,
  pruneShares,
  PRUNE_GRACE_MS,
  MIN_REUSE_MS,
  remainingMs,
  expiryText,
  readShareList,
  reusableShare,
  reuseNotice,
  planShare,
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

test("every failure message is distinct from every other", () => {
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

// The shares list reads these records back to list and re-check shares. Every field is
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

// Records are dropped from storage on every write, because each one holds a
// 256-bit key that exists nowhere else and is pure residue once its object is
// gone. The grace window is the whole subtlety: the bucket removes an object
// within about a day of its TTL, so a share that has only just expired may
// still be live, and pruning it would destroy the key to something the endpoint
// is still serving - which is exactly what the panel's own clear-from-list
// confirm promises will not happen behind the user's back.
test("a record is prunable only once its object is certainly gone, not at expiry", () => {
  const r = record();
  assert.ok(PRUNE_GRACE_MS >= 86400000, "the grace must cover the bucket's own deletion lag");
  assert.strictEqual(isPrunable(r, expiresAt(r)), false, "expired is not yet certainly deleted");
  assert.strictEqual(isPrunable(r, expiresAt(r) + PRUNE_GRACE_MS - 1), false);
  assert.strictEqual(isPrunable(r, expiresAt(r) + PRUNE_GRACE_MS), true);
});

test("pruning keeps live shares, recently expired ones, and anything undatable", () => {
  const live = record({ objectId: "A".repeat(22) });
  const justExpired = record({ objectId: "B".repeat(22), createdAt: CREATED - SHARE_TTL_MS });
  const longGone = record({ objectId: "C".repeat(22), createdAt: CREATED - 30 * 24 * HOUR });
  const undatable = record({ objectId: "D".repeat(22), createdAt: "whenever" });

  const kept = pruneShares([live, justExpired, longGone, undatable, null, undefined], CREATED);
  assert.deepStrictEqual(
    kept.map((r) => r.objectId),
    ["A".repeat(22), "B".repeat(22), "D".repeat(22)],
    "only the certainly-dead record is dropped, and order is preserved"
  );
});

test("pruning a missing or non-array shares key yields an empty list", () => {
  for (const bad of [undefined, null, {}, "shares", 7]) {
    assert.deepStrictEqual(pruneShares(bad, CREATED), [], String(bad));
  }
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

/* ---- which share gets reused -------------------------------------------
 *
 * This is what stands between "copy a link to this moment" and re-uploading
 * 3.5 MB every time someone presses it, so it is tested as the decision it is
 * rather than left as a lookup inside a click handler.
 */

test("a match with no share at all has nothing to reuse", () => {
  assert.strictEqual(reusableShare([], "m1", CREATED), null);
  assert.strictEqual(reusableShare([record({ matchId: "m2" })], "m1", CREATED), null);
});

test("a live share for this match is what gets reused", () => {
  const found = reusableShare([record()], "m1", CREATED + HOUR);
  assert.ok(found, "a share created an hour ago must be reusable");
  assert.strictEqual(found.objectId, "A".repeat(22));
  assert.strictEqual(found.key, "B".repeat(43));
  // The record's own endpoint comes back, not the one in Settings: the object
  // lives where it was uploaded, however the setting has moved since.
  assert.strictEqual(found.endpoint, "https://share.example.workers.dev");
});

// Records are keyed by object id, so a match can hold several. The newest has
// the most days left on it, and that is the one worth handing out.
test("the newest live share wins when a match has several", () => {
  const found = reusableShare(
    [
      record({ objectId: "A".repeat(22), createdAt: CREATED }),
      record({ objectId: "C".repeat(22), createdAt: CREATED + 2 * HOUR }),
      record({ objectId: "B".repeat(22), createdAt: CREATED + HOUR })
    ],
    "m1",
    CREATED + 3 * HOUR
  );
  assert.strictEqual(found.objectId, "C".repeat(22));
});

// The object behind an expired record is gone or going, so reusing it would
// hand over a link that opens to nothing. Uploading again is the right answer.
test("an expired share is never reused, however recent it is otherwise", () => {
  const stale = record({ createdAt: CREATED });
  assert.strictEqual(reusableShare([stale], "m1", CREATED + SHARE_TTL_MS), null);
  assert.strictEqual(reusableShare([stale], "m1", CREATED + SHARE_TTL_MS + HOUR), null);
});

/* Unexpired is not the bar. A link is handed over to be opened later, so a
 * record with minutes left on it is reused into a share the sharer believes they
 * just made and the recipient finds dead tomorrow - and nothing can re-share or
 * revoke it. A fresh upload costs 3.5 MB and buys seven days. */
test("a share about to expire is uploaded afresh rather than reused", () => {
  const stale = record({ createdAt: CREATED });
  const dies = CREATED + SHARE_TTL_MS;
  assert.ok(reusableShare([stale], "m1", dies - MIN_REUSE_MS), "exactly the minimum still reuses");
  assert.strictEqual(reusableShare([stale], "m1", dies - MIN_REUSE_MS + 1), null, "one ms under does not");
  assert.strictEqual(reusableShare([stale], "m1", dies - HOUR), null, "an hour left is not a share");
});

// The figure itself, because it is a promise about what a reused link is worth:
// never less than the slack the bucket's own lifecycle rule runs with.
test("the reuse floor is a day, and a day is less than the TTL", () => {
  assert.strictEqual(MIN_REUSE_MS, 86400000);
  assert.ok(MIN_REUSE_MS < SHARE_TTL_MS, "a floor at or above the TTL would reuse nothing, ever");
  assert.strictEqual(remainingMs(record(), CREATED), SHARE_TTL_MS);
  assert.strictEqual(remainingMs(record(), CREATED + SHARE_TTL_MS + HOUR), -HOUR, "gone reads negative");
});

test("the newest UNEXPIRED share wins, not simply the newest", () => {
  const found = reusableShare(
    [
      record({ objectId: "A".repeat(22), createdAt: CREATED - 3 * HOUR }),
      record({ objectId: "C".repeat(22), createdAt: CREATED - SHARE_TTL_MS - HOUR })
    ],
    "m1",
    CREATED
  );
  assert.strictEqual(found.objectId, "A".repeat(22), "the expired newer record must be skipped");
});

test("shares for other matches are never reused for this one", () => {
  const found = reusableShare(
    [record({ objectId: "C".repeat(22), matchId: "m2", createdAt: CREATED + HOUR }), record()],
    "m1",
    CREATED + 2 * HOUR
  );
  assert.strictEqual(found.objectId, "A".repeat(22));
});

/* A record that cannot rebuild a link is not a share to reuse - reusing it
 * would produce a link that decrypts to nothing, and it would do so instead of
 * the upload that would have worked. readShareList already drops these; this
 * asserts the reuse path is behind that filter rather than beside it. */
test("a record that could never produce a link is not reused", () => {
  const broken = [
    record({ key: "" }),
    record({ key: "B".repeat(42) }),
    record({ objectId: "A".repeat(21) }),
    record({ createdAt: 0 }),
    null,
    "nonsense"
  ];
  assert.strictEqual(reusableShare(broken, "m1", CREATED), null);
});

test("an unreadable shares key or a missing match id reuses nothing", () => {
  for (const bad of [undefined, null, {}, "shares", 7]) {
    assert.strictEqual(reusableShare(bad, "m1", CREATED), null, String(bad));
  }
  for (const bad of [undefined, null, ""]) {
    assert.strictEqual(reusableShare([record()], bad, CREATED), null, String(bad));
  }
});

/* ---- reuse, unless forced ----------------------------------------------
 *
 * Two buttons produce a share link - the replay modal's "copy a link to this
 * moment" and the match row's "Create share link" - and both take this
 * decision. It is a decision and not a lookup because of the escape hatch: a
 * forced upload must not be talked out of itself by a share that happens to be
 * live.
 */

test("a live share is reused, and its record comes back to rebuild the link from", () => {
  const plan = planShare([record()], "m1", CREATED + HOUR, { forceNew: false });
  assert.strictEqual(plan.action, "reuse");
  assert.strictEqual(plan.record.objectId, "A".repeat(22));
});

test("nothing live means an upload, and no record to pretend otherwise with", () => {
  assert.deepStrictEqual(planShare([], "m1", CREATED, { forceNew: false }), {
    action: "upload",
    record: null
  });
  // Expired, and one an hour short of the reuse floor: both are uploads.
  const stale = record({ createdAt: CREATED });
  assert.strictEqual(planShare([stale], "m1", CREATED + SHARE_TTL_MS).action, "upload");
  assert.strictEqual(planShare([stale], "m1", CREATED + SHARE_TTL_MS - HOUR).action, "upload");
});

/* The escape hatch. Someone about to publish a link wants the full seven days,
 * not the two left on a share made five days ago, and there is no other way to
 * get them: a share cannot be extended, re-uploaded in place, or revoked. */
test("forcing uploads even when a share with days left exists", () => {
  const plan = planShare([record()], "m1", CREATED + HOUR, { forceNew: true });
  assert.deepStrictEqual(plan, { action: "upload", record: null });
});

// Skipping the lookup rather than overriding its answer is the point: a share
// landing between the press and the read must not turn a forced upload into a
// reuse of the very share the presser was refusing.
test("forcing ignores a share that landed a moment ago", () => {
  const justLanded = [record({ objectId: "C".repeat(22), createdAt: CREATED + HOUR })];
  assert.strictEqual(planShare(justLanded, "m1", CREATED + HOUR, { forceNew: true }).action, "upload");
});

test("no options at all reads as not forced", () => {
  assert.strictEqual(planShare([record()], "m1", CREATED + HOUR).action, "reuse");
  assert.strictEqual(planShare([record()], "m1", CREATED + HOUR, {}).action, "reuse");
});

/* The sentence a reused link is handed over with. It is asserted rather than
 * left to the two panels because it carries the one fact the presser cannot
 * otherwise learn: they got what is left of a week, not a fresh one. */
test("a reused link says it is reused and when it dies", () => {
  const now = CREATED + 5 * 86400000;
  const text = reuseNotice(record(), now);
  assert.match(text, /Reusing the share already made for this match/);
  assert.match(text, /no second upload/);
  assert.ok(text.includes(expiryText(record(), now)), "the remaining life must be spelled out");
  assert.match(text, /in 2 days/);
});

// The outcomes need different reactions from the reader: the link works, the
// link is dead, or nothing was learned. Collapsing "unreachable" into "gone"
// would tell someone a share had expired when it had not.
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
  assert.strictEqual(odd.state, "unexpected");
  assert.strictEqual(odd.message, RECHECK_MESSAGES.unexpected);
});

test("an unexpected status names itself so the number is not lost", () => {
  const busy = describeRecheck({ reached: true, status: 503 });
  assert.strictEqual(busy.state, "unexpected");
  assert.match(busy.message, /503/);
});

const ALL_OUTCOMES = [
  { reached: true, status: 200, magic: true },
  { reached: true, status: 206, magic: true },
  { reached: true, status: 404 },
  { reached: true, status: 410 },
  { reached: true, status: 200, magic: false },
  { reached: true, status: 503 },
  { reached: false },
  {}
];

test("every re-check outcome carries a short label and a message", () => {
  for (const outcome of ALL_OUTCOMES) {
    const o = describeRecheck(outcome);
    assert.ok(o.label && o.label.length < 20, `a pill needs a short label, got ${o.label}`);
    assert.ok(o.message, `every outcome needs a message: ${JSON.stringify(outcome)}`);
  }
});

test("the four outcomes a reader must tell apart are worded apart", () => {
  const shown = [
    { reached: true, status: 200, magic: true },
    { reached: true, status: 404 },
    { reached: true, status: 200, magic: false },
    { reached: false }
  ].map(describeRecheck);
  assert.strictEqual(new Set(shown.map((o) => o.message)).size, 4, "outcomes must not share wording");
  assert.strictEqual(new Set(shown.map((o) => o.label)).size, 4, "outcomes must not share a pill");
});

/* The label is a pill rendered immediately before the message, so the two read
 * as one sentence. "no answer" beside "The endpoint answered with something
 * that isn't a replay" reads as a bug in the checker, and that pairing shipped
 * once - asserting the label is merely short does not catch it. */
test("only an endpoint that said nothing is labelled as silence", () => {
  for (const outcome of ALL_OUTCOMES) {
    const o = describeRecheck(outcome);
    const silent = !outcome.reached;
    const where = `${JSON.stringify(outcome)} -> "${o.label}" / "${o.message}"`;
    assert.strictEqual(o.label === RECHECK_LABELS.unreachable, silent, `label contradicts ${where}`);
    assert.strictEqual(/couldn't reach/i.test(o.message), silent, `message contradicts ${where}`);
  }
});
