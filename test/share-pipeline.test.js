/* Which message a failed share earns, and whether it offers to try again.
 *
 * The upload itself - crypto, fetch, IndexedDB - gets no unit tests by project
 * convention. This is the one decision in it that is decidable from data alone,
 * and it is the one that reaches the user: a retry offered for a failure that
 * repeats identically is a lie, and a local failure reported as "couldn't reach
 * the share endpoint" sends someone to Settings for a fault in this build.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SHARE = require("../share/share-ui-support.js");
const P = require("../dashboard/share-pipeline.js");
const { ShareUiError, ShareUploadError, shareFailure } = P;

test("a failure the flow raised carries its own message and its own offer", () => {
  assert.deepEqual(shareFailure(new ShareUiError("This replay is too big.", false)), {
    error: "This replay is too big.",
    retry: false,
  });
  assert.deepEqual(shareFailure(new ShareUiError(SHARE.MESSAGES.unverified, true)), {
    error: SHARE.MESSAGES.unverified,
    retry: true,
  });
});

test("an upload failure is read through the status the endpoint answered", () => {
  for (const [status, kind] of [
    [403, "rejected"],
    [413, "tooLarge"],
    [429, "rateLimited"],
    [500, "misconfigured"],
    [503, "unavailable"],
  ]) {
    const shown = shareFailure(new ShareUploadError(Object.assign(new Error("nope"), { status })));
    assert.equal(shown.error, SHARE.MESSAGES[kind], `${status} should read as ${kind}`);
    assert.equal(shown.retry, SHARE.RETRYABLE.includes(kind), `${status} retry offer`);
  }
});

test("an upload that never got a status is a transport failure, and retryable", () => {
  const shown = shareFailure(new ShareUploadError(new TypeError("Failed to fetch")));
  assert.equal(shown.error, SHARE.MESSAGES.network);
  assert.equal(shown.retry, true);
});

test("anything else is a local failure, and never blames the endpoint", () => {
  /* The CSS re-strip, the crypto, a script tag that did not load. None of it
   * says anything about the endpoint, and a second attempt would fail in
   * exactly the same way. */
  for (const err of [new TypeError("assets is not iterable"), new Error("x"), "a string", null]) {
    assert.deepEqual(
      shareFailure(err),
      { error: SHARE.MESSAGES.unprepared, retry: false },
      String(err)
    );
  }
});

test("a local failure that happens to carry a status is still a local failure", () => {
  /* This is the whole reason the upload error is a wrapper class rather than a
   * shape sniffed afterwards: anything can have a `status` property, and
   * reading one off a local fault would offer a retry for something that
   * repeats identically. */
  const local = Object.assign(new Error("something with a status"), { status: 503 });
  assert.deepEqual(shareFailure(local), { error: SHARE.MESSAGES.unprepared, retry: false });
});

test("the retry offered for an unconfirmed upload agrees with the taxonomy", () => {
  /* PINNED, not fixed. `verifyObject` builds its ShareUiError with a hardcoded
   * retry flag rather than deriving it from RETRYABLE, which is exported and
   * says the same thing today. Nothing else keeps them agreeing: drop
   * "unverified" from RETRYABLE and the panel keeps offering "Try again" for a
   * failure the taxonomy has decided is permanent.
   *
   * Asserted over the source because the literal is not reachable as data - the
   * only other way to see it is a fetch. The repo already checks cross-file
   * invariants this way; see test/vendor-contract.test.js. */
  const source = fs.readFileSync(path.join(__dirname, "..", "dashboard", "share-pipeline.js"), "utf8");
  const hardcoded = source.match(
    /new ShareUiError\(\s*SHARE\.MESSAGES\.unverified\s*,\s*(true|false)\s*\)/
  );
  assert.ok(
    hardcoded,
    "verifyObject no longer raises ShareUiError(MESSAGES.unverified, <literal>) - this pin has " +
      "stopped watching the thing it exists to watch, so teach it the new shape."
  );
  assert.equal(
    hardcoded[1] === "true",
    SHARE.RETRYABLE.includes("unverified"),
    "verifyObject's hardcoded retry flag and share-ui-support's RETRYABLE list now disagree " +
      "about whether an unconfirmed upload is worth trying again"
  );
});
