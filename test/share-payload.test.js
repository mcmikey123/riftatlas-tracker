const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSharePayload,
  parseSharePayload,
  generateKey,
  exportKey,
  importKey,
  HEADER_BYTES
} = require("../share/payload.js");

// Node provides crypto, CompressionStream and DecompressionStream as globals, so these
// tests exercise the real defaults. The deps seam exists so callers can stub them; an empty
// object takes exactly the path the extension takes.
const deps = {};
const fixture = {
  meta: { matchId: "m1", viewport: { w: 1920, h: 1080 } },
  events: [{ type: 2, timestamp: 1 }, { type: 3, timestamp: 2 }],
  assets: { abc123: ".board{color:red}" }
};

test("a payload round-trips through build and parse", async () => {
  const key = await generateKey(deps);
  const bytes = await buildSharePayload(fixture, key, deps);
  assert.ok(bytes instanceof Uint8Array);
  assert.deepStrictEqual(await parseSharePayload(bytes, key, deps), fixture);
});

test("the frame carries the RAR1 magic and the deflate flag", async () => {
  const key = await generateKey(deps);
  const bytes = await buildSharePayload(fixture, key, deps);
  assert.deepStrictEqual([...bytes.slice(0, 4)], [0x52, 0x41, 0x52, 0x31]);
  assert.strictEqual(bytes[4], 0x01);
});

test("the wrong key is rejected as OperationError, not as a format error", async () => {
  const bytes = await buildSharePayload(fixture, await generateKey(deps), deps);
  const wrong = await generateKey(deps);
  await assert.rejects(() => parseSharePayload(bytes, wrong, deps), { name: "OperationError" });
});

test("a flipped ciphertext byte is rejected as OperationError", async () => {
  const key = await generateKey(deps);
  const bytes = await buildSharePayload(fixture, key, deps);
  // Indexed off HEADER_BYTES so this stays a ciphertext-corruption test if the header grows.
  bytes[HEADER_BYTES + 8] ^= 0xff;
  await assert.rejects(() => parseSharePayload(bytes, key, deps), { name: "OperationError" });
});

test("bad magic is a distinct named error, not a decryption failure", async () => {
  const key = await generateKey(deps);
  const bytes = await buildSharePayload(fixture, key, deps);
  bytes[0] = 0x58;
  await assert.rejects(() => parseSharePayload(bytes, key, deps), {
    name: "ShareFormatError",
    message: /not a Rift Atlas replay/
  });
});

// The truncation test below slices a real frame, so its magic is intact and it passes
// whichever order the checks run in. Short non-replay input is the case that separates
// "you opened the wrong file" from "this replay was cut off" — different remedies.
test("short input that was never a replay is a format error, not a truncation", async () => {
  const key = await generateKey(deps);
  await assert.rejects(() => parseSharePayload(new Uint8Array(10).fill(0x99), key, deps), {
    name: "ShareFormatError",
    message: /not a Rift Atlas replay/
  });
});

test("input too short to even hold the magic is reported as truncated", async () => {
  const key = await generateKey(deps);
  await assert.rejects(() => parseSharePayload(new Uint8Array(2), key, deps), {
    name: "ShareTruncatedError"
  });
});

test("a truncated buffer is a distinct named error", async () => {
  const key = await generateKey(deps);
  const bytes = await buildSharePayload(fixture, key, deps);
  await assert.rejects(() => parseSharePayload(bytes.slice(0, 20), key, deps), {
    name: "ShareTruncatedError"
  });
});

test("an unknown flag bit is refused rather than ignored", async () => {
  const key = await generateKey(deps);
  const bytes = await buildSharePayload(fixture, key, deps);
  bytes[4] = 0x03;
  await assert.rejects(() => parseSharePayload(bytes, key, deps), { name: "ShareFormatError" });
});

test("a key survives export and import as 32 raw bytes", async () => {
  const key = await generateKey(deps);
  const raw = await exportKey(key, deps);
  assert.strictEqual(raw.length, 32);
  const bytes = await buildSharePayload(fixture, key, deps);
  const reimported = await importKey(raw, deps);
  assert.deepStrictEqual(await parseSharePayload(bytes, reimported, deps), fixture);
});
