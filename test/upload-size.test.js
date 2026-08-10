const test = require("node:test");
const assert = require("node:assert/strict");

const { checkUploadSize, parseByteCount } = require("../share/worker/src/upload-size.js");

const CAP = "12582912"; // 12 MB, matching wrangler.toml.example

test("an upload inside the cap is accepted with its declared size", () => {
  const result = checkUploadSize("3700000", CAP);
  assert.deepStrictEqual(result, { ok: true, bytes: 3700000, limit: 12582912 });
});

test("a declaration over the cap is refused with 413", () => {
  const result = checkUploadSize("13000000", CAP);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 413);
  assert.strictEqual(result.body.declared, 13000000);
});

test("exactly the cap is allowed, one byte over is not", () => {
  assert.strictEqual(checkUploadSize("12582912", CAP).ok, true);
  assert.strictEqual(checkUploadSize("12582913", CAP).status, 413);
});

// The cap is the control the abuse model rests on. A config typo previously made it
// vanish silently, because Number(undefined) is NaN and every NaN comparison is false.
test("a missing or unparseable cap fails closed with 500, never open", () => {
  for (const badCap of [undefined, "", "  ", "twelve", "12.5", "0x10", "-1", "0", null]) {
    const result = checkUploadSize("100", badCap);
    assert.strictEqual(result.ok, false, `cap ${JSON.stringify(badCap)} must not be accepted`);
    assert.strictEqual(result.status, 500, `cap ${JSON.stringify(badCap)} must fail closed`);
  }
});

test("a missing or unparseable content-length is refused with 411", () => {
  for (const bad of [null, undefined, "", "abc", "12.5", "0x10", "-5", "0"]) {
    const result = checkUploadSize(bad, CAP);
    assert.strictEqual(result.status, 411, `content-length ${JSON.stringify(bad)} must be 411`);
  }
});

test("the misconfiguration response does not disclose the limit", () => {
  // A 500 here means the operator broke the config; the caller learns nothing about it.
  assert.deepStrictEqual(checkUploadSize("100", "nonsense").body, { error: "server misconfigured" });
});

test("parseByteCount accepts only whole positive byte counts", () => {
  assert.strictEqual(parseByteCount("100"), 100);
  assert.strictEqual(parseByteCount(" 100 "), 100);
  for (const bad of ["12.5", "0x10", "-1", "0", "1e3", "", "abc", null, 100]) {
    assert.strictEqual(parseByteCount(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});
