/* What a row of the Shared links list says.
 *
 * This list is the only register of what has left the machine. There is no
 * revocation and no delete button: a share is served until the endpoint's own
 * 7-day rule removes it, and the payload carries an opponent's display name and
 * the match chat. So the row has to be right about three things, none of which
 * throws when it is wrong:
 *
 *   which match it came from, including when that match is gone;
 *   whether it has expired, because only an expired row may offer to be
 *   forgotten - and forgetting takes the only copy of its decryption key;
 *   what a re-check learned, where "no answer" and "gone" must never be
 *   confused for one another.
 *
 * The record filter, the expiry wording and the outcome mapping are tested in
 * test/share-ui-support.test.js. What is here is what the row does with them.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { esc, DASH } = require("../dashboard/format.js");
const SHARE = require("../share/share-ui-support.js");
const V = require("../dashboard/shares-view.js");

const NOW = Date.parse("2026-08-14T12:00:00Z");
const DAY = 86400000;
const OBJECT_ID = "AbCdEfGhIjKlMnOpQrStUv";
const KEY = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcdA";
const record = (over) =>
  Object.assign(
    {
      matchId: "m1",
      objectId: OBJECT_ID,
      key: KEY,
      endpoint: "https://shares.example",
      createdAt: NOW - DAY,
    },
    over
  );

const match = (over) =>
  Object.assign(
    {
      id: "m1",
      startedAt: "2026-05-02T20:14:00Z",
      myChampion: "Alba, the Dawnbreaker",
      opponentChampion: "Corin, Tidecaller",
    },
    over
  );

// ---- matchLabel --------------------------------------------------------

test("a row names the match by when it was played and who was in it", () => {
  const label = V.matchLabel(record(), match());
  assert.ok(label.includes("Alba"), "the champion, not the whole legend field");
  assert.ok(label.includes("Corin"));
  assert.ok(label.includes(new Date("2026-05-02T20:14:00Z").toLocaleDateString()));
});

test("a share whose match has been deleted says so, not a bare id", () => {
  /* A share outlives its match: deleting a match cannot reach the copy on the
   * endpoint. The row still has to be readable, and an object id nobody can
   * place is not a label. */
  assert.equal(V.matchLabel(record(), null), "match no longer in your history");
});

test("a match with no start time still gets a matchup, not a broken date", () => {
  const label = V.matchLabel(record(), match({ startedAt: null }));
  assert.ok(label.startsWith(DASH), "a missing timestamp is a dash, never Invalid Date");
  assert.ok(label.includes("Alba"));
});

test("a match missing both champions reads as Unknown rather than blank", () => {
  const label = V.matchLabel(record(), match({ myChampion: null, opponentChampion: null }));
  assert.ok(label.includes("Unknown vs Unknown"));
});

// ---- recheckHtml -------------------------------------------------------

test("a share nobody has re-checked shows nothing at all", () => {
  // Not "unknown", not a dash: the question has not been asked, and a row that
  // answers it unasked would be claiming to know something.
  assert.equal(V.recheckHtml(undefined), "");
});

test("a re-check in flight says the endpoint is being asked", () => {
  assert.ok(V.recheckHtml({ busy: true }).includes("Asking the endpoint…"));
});

test("each re-check outcome is shown with its own label and message", () => {
  for (const [outcome, state] of [
    [{ reached: true, status: 200, magic: true }, "alive"],
    [{ reached: true, status: 404 }, "gone"],
    [{ reached: false }, "unreachable"],
    [{ reached: true, status: 200, magic: false }, "unexpected"],
  ]) {
    const html = V.recheckHtml(SHARE.describeRecheck(outcome));
    assert.ok(html.includes(`sh-${state}`), `${state} needs its own class`);
    assert.ok(html.includes(esc(SHARE.RECHECK_LABELS[state])));
    assert.ok(
      html.includes(esc(SHARE.RECHECK_MESSAGES[state])),
      `${state} must carry the message, not just the label`
    );
  }
});

// ---- listRowHtml -------------------------------------------------------

const row = (rec, recheck) => V.listRowHtml(rec, NOW, "2 May · Alba vs Corin", recheck);

test("a live share offers a re-check and a copy, and nothing that forgets it", () => {
  const html = row(record());
  assert.match(html, new RegExp(`data-sharerecheck="${OBJECT_ID}"`));
  assert.match(html, new RegExp(`data-sharelistcopy="${OBJECT_ID}"`));
  assert.ok(
    !html.includes("data-shareforget"),
    "clearing a live share would throw away the key to a link that still opens"
  );
  assert.ok(!html.includes("sh-expired-row"));
});

test("an expired share is marked as such and may be cleared from the list", () => {
  const html = row(record({ createdAt: NOW - SHARE.SHARE_TTL_MS - DAY }));
  assert.ok(html.includes("sh-expired-row"));
  assert.match(html, new RegExp(`data-shareforget="${OBJECT_ID}"`));
  assert.ok(html.includes("expired 1 day ago"));
});

test("a share is live right up to its TTL and expired the moment it passes", () => {
  // The boundary is what decides whether "Clear from list" is offered, and the
  // confirm behind it is worded for a share whose time is already up.
  const justAlive = row(record({ createdAt: NOW - SHARE.SHARE_TTL_MS + 1 }));
  const justGone = row(record({ createdAt: NOW - SHARE.SHARE_TTL_MS }));
  assert.ok(!justAlive.includes("data-shareforget"));
  assert.ok(justGone.includes("data-shareforget"));
});

test("the re-check button is disabled while its own re-check is out", () => {
  // Two overlapping reads of the same object would let a stale answer land
  // last, and the button gives no other sign that anything is happening.
  assert.ok(row(record(), { busy: true }).includes("disabled"));
  assert.ok(!row(record(), undefined).includes("disabled"));
});

test("a row's answer sits in its own live region, keyed by object id", () => {
  // Re-checking repaints just this cell, so the row keeps keyboard focus.
  const html = row(record(), SHARE.describeRecheck({ reached: false }));
  assert.match(html, new RegExp(`data-sharestatus="${OBJECT_ID}"`));
  assert.ok(html.includes('aria-live="polite"'));
  assert.ok(html.includes(esc(SHARE.RECHECK_MESSAGES.unreachable)));
});

test("the link on the row is rebuilt from the record, not from a stored string", () => {
  // Nothing stores the link: the record is the only copy of the key, so the row
  // has to be able to rebuild it - against the endpoint the share went to.
  const html = row(record({ endpoint: "https://old.example" }));
  assert.ok(html.includes(`value="https://old.example/#1.${OBJECT_ID}.${KEY}"`));
});

test("a match label is escaped into the row and into the field's name", () => {
  const html = V.listRowHtml(record(), NOW, '<img src=x> "quoted"', undefined);
  assert.ok(!html.includes("<img"), "a deck or opponent name cannot inject markup");
  assert.ok(html.includes("aria-label=\"Share link for &lt;img src=x&gt; &quot;quoted&quot;\""));
});
