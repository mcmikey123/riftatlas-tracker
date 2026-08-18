/* What the share panel under a match says, given one share state.
 *
 * Every failure here is silent in a browser and expensive in the world. A panel
 * that offers "Create share link" for a failure that repeats identically wastes
 * a click; one that offers nothing for a failure a retry would fix strands the
 * user with no way forward; one that drops the disclosure uploads a replay
 * carrying an opponent's name and the match chat without saying so; and one
 * that hides the error raised while a link is on screen leaves a button that
 * appears to do nothing however often it is pressed.
 *
 * The panel is rendered as a string, so all of that is decidable from the state
 * and a clock. The DOM half - which boxes exist and when they repaint - is not
 * tested, by project convention.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { esc } = require("../dashboard/format.js"); // also publishes RATrackerFormat
const SHARE = require("../share/share-ui-support.js");
const P = require("../dashboard/share-panel.js");

const NOW = Date.parse("2026-08-14T12:00:00Z");
// 22 and 43 base64url characters: the shapes share/hosts.js validates.
const OBJECT_ID = "AbCdEfGhIjKlMnOpQrStUv";
/* 43 base64url characters is 256 bits with two bits to spare, so only a key
 * whose last character carries nothing in those two bits survives a decode and
 * re-encode unchanged. Ending in "A" is one such: a key ending in "e" comes
 * back as "c", which is a property of the encoding and not of the link. */
const KEY = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcdA";
const record = (over) =>
  Object.assign(
    {
      matchId: "m1",
      objectId: OBJECT_ID,
      key: KEY,
      endpoint: "https://shares.example",
      createdAt: NOW - SHARE.SHARE_TTL_MS / 2,
    },
    over
  );

// ---- the disclosure ----------------------------------------------------

test("every state carries the disclosure, because consent is asked at the panel", () => {
  const states = [
    {},
    { phase: "uploading" },
    { error: "nope", retry: true },
    { error: "nope", retry: false },
    { link: "https://shares.example/#1.a.b", createdAt: NOW },
  ];
  for (const s of states) {
    const html = P.shareBoxHtml(s, "m1", NOW);
    assert.ok(
      html.includes("End-to-end encrypted"),
      "the reassurance is missing from " + JSON.stringify(s)
    );
    assert.ok(
      html.includes("can't be unshared"),
      "the caveat is missing from " + JSON.stringify(s)
    );
  }
});

test("the disclosure names the same TTL the taxonomy enforces", () => {
  // Two numbers, one promise. The panel says how long a link lasts; the store
  // prunes and reuses by SHARE_TTL_DAYS, and a panel promising a different
  // number would be the one the user believes.
  assert.ok(P.DISCLOSURE.includes(`after ${SHARE.SHARE_TTL_DAYS} days`));
});

// ---- what each state offers --------------------------------------------

test("a fresh panel offers the upload as a second, deliberate click", () => {
  const html = P.shareBoxHtml({}, "m1", NOW);
  assert.match(html, /data-sharego="m1"/);
  assert.ok(html.includes("Create share link"));
});

test("a share in flight shows its phase and no button to press again", () => {
  for (const [phase, words] of Object.entries(P.PHASES)) {
    const html = P.shareBoxHtml({ phase }, "m1", NOW);
    assert.ok(html.includes(words), `${phase} should say ${words}`);
    assert.ok(!html.includes("data-sharego"), `${phase} must not offer a second start`);
  }
});

test("a phase nobody has named still says something is happening", () => {
  // A new phase added to the pipeline and not to PHASES must not paint an
  // empty panel that reads as a share which quietly stopped.
  assert.ok(P.shareBoxHtml({ phase: "wat" }, "m1", NOW).includes("Working…"));
});

test("a retryable failure offers Try again", () => {
  const html = P.shareBoxHtml({ phase: "idle", error: SHARE.MESSAGES.network, retry: true }, "m1", NOW);
  // Escaped, because it is a message rendered into markup - "Couldn't" reaches
  // the page as "Couldn&#39;t".
  assert.ok(html.includes(esc(SHARE.MESSAGES.network)));
  assert.match(html, /data-sharego="m1"/);
  assert.ok(html.includes("Try again"), "a second attempt is not a first one");
});

test("a failure that would repeat identically offers no button at all", () => {
  // The failure taxonomy calls these non-retryable precisely because pressing
  // again fails the same way; a button here would be a lie.
  const html = P.shareBoxHtml({ phase: "idle", error: SHARE.MESSAGES.unprepared, retry: false }, "m1", NOW);
  assert.ok(html.includes(SHARE.MESSAGES.unprepared));
  assert.ok(!html.includes("data-sharego"));
  assert.ok(!html.includes("data-sharenew"));
});

test("a finished share shows the link, a copy button and when it expires", () => {
  const link = "https://shares.example/#1.abc.def";
  const html = P.shareBoxHtml({ phase: "done", link, createdAt: NOW }, "m1", NOW);
  assert.ok(html.includes(`value="${link}"`));
  assert.match(html, /data-sharelink="m1"/);
  assert.match(html, /data-sharecopy="m1"/);
  assert.ok(html.includes("Uploaded and verified."));
  assert.ok(
    html.includes(new Date(NOW + SHARE.SHARE_TTL_MS).toLocaleDateString()),
    "the expiry date is counted from the share, not from now"
  );
});

test("a reused link says what it has left and offers a fresh upload", () => {
  const reuse = record({ createdAt: NOW - 5 * 86400000 });
  const html = P.shareBoxHtml(
    { phase: "idle", link: "https://shares.example/#1.abc.def", createdAt: reuse.createdAt, reuse },
    "m1",
    NOW
  );
  // The same sentence the replay modal's reuse shows, so two buttons cannot
  // describe one decision differently.
  assert.ok(html.includes("Reusing the share already made for this match"));
  assert.ok(html.includes("in 2 days"), "what is left of the seven days is said out loud");
  assert.match(html, /data-sharenew="m1"/);
  assert.ok(!html.includes("Uploaded and verified."), "a reuse is not an upload");
});

test("an error raised while a link is on screen is painted with the link", () => {
  /* "Create a new link anyway" can be refused - another match is uploading, or
   * the stored endpoint is broken - and the refusal sets an error without
   * clearing the link. Without this branch the button silently re-enables
   * itself and nothing else happens, however many times it is pressed. */
  const html = P.shareBoxHtml(
    {
      phase: "idle",
      link: "https://shares.example/#1.abc.def",
      createdAt: NOW,
      reuse: record(),
      error: "Another replay is being shared right now.",
    },
    "m1",
    NOW
  );
  assert.ok(html.includes("Another replay is being shared right now."));
  assert.ok(html.includes('value="https://shares.example/#1.abc.def"'), "the link survives the error");
});

test("nothing a failure or a match id carries reaches the page as markup", () => {
  const html = P.shareBoxHtml({ error: '<img src=x onerror="alert(1)">', retry: true }, '"><b>', NOW);
  assert.ok(!html.includes("<img"), "the error message is escaped");
  assert.ok(!html.includes("<b>"), "the match id is escaped");
});

// ---- the link row ------------------------------------------------------

test("the link field is announced by what it links to, and keyed as asked", () => {
  const html = P.shareLinkRowHtml("https://shares.example/#1.a.b", "obj1", {
    label: "2 May · Alba vs Corin",
    field: "sharelistlink",
    copy: "sharelistcopy",
    copyText: "Copy",
  });
  // A read-only field with no accessible name announces as "edit text", which
  // is what the two copies of this said before they became one.
  assert.ok(html.includes('aria-label="Share link for 2 May · Alba vs Corin"'));
  assert.match(html, /data-sharelistlink="obj1"/);
  assert.match(html, /data-sharelistcopy="obj1"/);
  assert.ok(html.includes(">Copy<"));
});

// ---- linkFor -----------------------------------------------------------

test("a link is rebuilt against the record's own endpoint", () => {
  // A share uploaded before the Settings endpoint changed still lives where it
  // was put, so a link built against the current setting opens nothing.
  const link = P.linkFor(record({ endpoint: "https://old.example" }));
  assert.ok(link.startsWith("https://old.example/#"));
  assert.ok(link.includes(OBJECT_ID));
});

test("a link carries no timestamp unless one is asked for", () => {
  const fragment = (link) => link.slice(link.indexOf("#") + 1);
  assert.equal(
    fragment(P.linkFor(record())).split(".").length,
    3,
    "three fields: version, object, key"
  );
  assert.ok(P.linkFor(record(), 92).endsWith(".92"), "only the moment link pins a position");
});

/* The shares list rebuilds links for records it knows nothing else about, and
 * passes neither a position nor a rate; only "copy a link to this moment" does.
 * A rate leaking into the list's links would pin every share to whatever the
 * last replay happened to be playing at. */
test("a link carries no playback rate unless one is asked for", () => {
  assert.ok(!P.linkFor(record()).includes(".s"), "a plain share link names no rate");
  assert.ok(!P.linkFor(record(), 92).includes(".s"), "a moment alone names no rate");
  assert.ok(
    !P.linkFor(record(), 92, 1).includes(".s"),
    "1x is what a viewer does anyway, so it is not written"
  );
  assert.ok(P.linkFor(record(), 92, 2).endsWith(".92.s20"), "2x rides as tenths behind an s");
  assert.ok(P.linkFor(record(), undefined, 0.5).endsWith(".s5"), "a rate needs no position");
});

test("the key travels in the fragment, where the endpoint's logs cannot see it", () => {
  const link = P.linkFor(record());
  assert.ok(link.includes("#"));
  assert.ok(link.slice(link.indexOf("#")).includes(KEY));
  assert.ok(!link.slice(0, link.indexOf("#")).includes(KEY));
});
