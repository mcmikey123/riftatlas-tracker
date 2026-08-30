/* The arithmetic behind the replay transport.
 *
 * These helpers decide which moments the chapter chips and the step buttons
 * land on, and what a truncated capture tells the viewer it covered. They were
 * extracted out of the dashboard viewer to be shared with the standalone share
 * viewer, and being pure is the whole reason that was possible — so they get
 * the coverage the mixed file never could have.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_SCALE,
  SEEK,
  INERT_LINK_RELS,
  isInertLink,
  stripInertLinks,
  hasPointerData,
  quantise,
  resumesAfterSeek,
  seekOutcome,
  startPosition,
  shouldAutoplay,
  targetOwnsKey,
  turnOf,
  timeline,
  evenly,
  truncationText,
  SPEEDS,
  normaliseSpeed
} = require("../replay/replay-timeline.js");

const CUSTOM = 5;
const FULL_SNAPSHOT = 2;

/** A recorder turn marker, as `capture/dom-recorder.js` emits them. */
const turnEvent = (timestamp, turnNumber) => ({
  type: CUSTOM,
  timestamp,
  data: { tag: "ra:turn", payload: { turnNumber } }
});

const snapshot = (timestamp) => ({ type: FULL_SNAPSHOT, timestamp, data: { node: {} } });
const mutation = (timestamp) => ({ type: 3, timestamp, data: {} });

test("the timeline is measured from the first event, not from the epoch", () => {
  const marks = timeline([mutation(5000), turnEvent(5000, 1), mutation(6000), turnEvent(7500, 2)]);
  assert.deepStrictEqual(marks, [
    { ms: 0, turn: 1 },
    { ms: 2500, turn: 2 }
  ]);
});

test("recorder turn markers win over full snapshots", () => {
  const marks = timeline([
    snapshot(1000),
    turnEvent(1000, 4),
    snapshot(2000),
    turnEvent(2000, 5)
  ]);
  assert.deepStrictEqual(
    marks.map((m) => m.turn),
    [4, 5],
    "the recorder's own turn numbers must survive, not be renumbered from one"
  );
});

test("without turn markers every full snapshot is a board state, numbered from one", () => {
  const marks = timeline([snapshot(100), mutation(150), snapshot(600), snapshot(1100)]);
  assert.deepStrictEqual(marks, [
    { ms: 0, turn: 1 },
    { ms: 500, turn: 2 },
    { ms: 1000, turn: 3 }
  ]);
});

test("a stream with neither markers nor snapshots has no board states", () => {
  assert.deepStrictEqual(timeline([mutation(10), mutation(20)]), []);
});

test("an empty stream has no board states rather than throwing", () => {
  assert.deepStrictEqual(timeline([]), []);
  assert.deepStrictEqual(timeline(undefined), []);
});

test("a turn marker is recognised by tag and by either payload spelling", () => {
  assert.strictEqual(turnOf(turnEvent(0, 3)), 3);
  assert.strictEqual(turnOf({ type: CUSTOM, data: { tag: "ra:turn", payload: { turn: 9 } } }), 9);
  assert.strictEqual(turnOf({ type: CUSTOM, data: { tag: "ra:turn", payload: { turnNumber: "7" } } }), 7);
});

test("anything that is not a numbered turn marker is not a board state", () => {
  assert.strictEqual(turnOf(null), null);
  assert.strictEqual(turnOf(snapshot(0)), null, "a full snapshot is not a custom event");
  assert.strictEqual(turnOf({ type: CUSTOM, data: { tag: "ra:mulligan", payload: { turnNumber: 2 } } }), null);
  assert.strictEqual(turnOf({ type: CUSTOM, data: { tag: "ra:turn", payload: { turnNumber: "x" } } }), null);
  assert.strictEqual(turnOf({ type: CUSTOM, data: { tag: "ra:turn" } }), null);
});

test("turn zero is a board state, not a falsy near-miss", () => {
  assert.strictEqual(turnOf(turnEvent(0, 0)), 0);
});

test("a mark list under the cap is passed through untouched", () => {
  const marks = [{ ms: 0, turn: 1 }, { ms: 10, turn: 2 }];
  assert.strictEqual(evenly(marks, 5), marks);
});

test("evenly caps the marks and always keeps the first and the last", () => {
  const marks = Array.from({ length: 97 }, (_, n) => ({ ms: n * 1000, turn: n + 1 }));
  const chips = evenly(marks, 30);

  assert.strictEqual(chips.length, 30);
  assert.deepStrictEqual(chips[0], marks[0]);
  assert.deepStrictEqual(chips[chips.length - 1], marks[marks.length - 1]);
  assert.deepStrictEqual(chips, [...chips].sort((a, b) => a.ms - b.ms), "chips must stay in order");
  assert.strictEqual(new Set(chips.map((c) => c.turn)).size, 30, "no turn should be shown twice");
});

test("evenly spaces the chips it keeps rather than clustering them", () => {
  const marks = Array.from({ length: 100 }, (_, n) => ({ ms: n * 1000, turn: n + 1 }));
  const gaps = evenly(marks, 10)
    .map((c) => c.turn)
    .slice(1)
    .map((turn, n, all) => turn - (n === 0 ? 1 : all[n - 1]));
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `gaps were ${gaps}`);
});

test("a truncated capture reports how far it got against the match length", () => {
  const text = truncationText({ state: "truncated", truncatedAtTurn: 12 }, { turns: 20 }, []);
  assert.strictEqual(text, "This replay covers turns 1–12 of 20; capture ran out of budget after that");
});

test("with no match length to compare against, the coverage stands alone", () => {
  const text = truncationText({ state: "truncated", truncatedAtTurn: 12 }, {}, []);
  assert.strictEqual(text, "This replay covers turns 1–12 of this match");
});

test("a capture that reached the last turn does not claim it ran out of budget", () => {
  const text = truncationText({ truncatedAtTurn: 20 }, { turns: 20 }, []);
  assert.strictEqual(text, "This replay covers turns 1–20 of this match");
});

test("without a recorded truncation point the last board state stands in", () => {
  const marks = [{ ms: 0, turn: 1 }, { ms: 900, turn: 6 }];
  assert.strictEqual(
    truncationText({}, { turns: 11 }, marks),
    "This replay covers turns 1–6 of 11; capture ran out of budget after that"
  );
});

test("a capture with nothing to report says only that it stops early", () => {
  assert.strictEqual(
    truncationText({}, { turns: 11 }, []),
    "This replay stops before the end of the match."
  );
});

test("the scale never overflows the room it was given", () => {
  for (const raw of [0.25, 0.333, 0.5, 0.87, 1.5, 1.999]) {
    assert.ok(quantise(raw) <= raw + 1e-9, `quantise(${raw}) = ${quantise(raw)} overflows the stage`);
    assert.ok(quantise(raw) > 0);
  }
});

test("the scale snaps to exactly 1:1 when it lands within a step of it", () => {
  assert.strictEqual(quantise(1), 1);
  assert.strictEqual(quantise(1.005), 1);
  assert.strictEqual(quantise(0.995), 1, "a hair under 1:1 is worth the sliver of unused room");
});

test("upscaling is allowed but capped", () => {
  assert.ok(quantise(1.5) > 1);
  assert.ok(Math.abs(quantise(9) - MAX_SCALE) < 1e-9);
});

/* The resume policy. Seeking moves the position; the play state is supposed to
 * survive it, which is the whole point of pulling this decision out of the
 * rrweb-shaped code that cannot be tested. */

const seeking = (extra) => Object.assign({ playing: true, ms: 1000, total: 10000 }, extra);

test("a scrub, a chapter chip and a Home/End jump all keep playing", () => {
  for (const reason of [SEEK.SCRUB, SEEK.CHAPTER, SEEK.JUMP]) {
    assert.strictEqual(resumesAfterSeek(seeking({ reason })), true, `${reason} stopped playback`);
  }
});

test("a seek made while paused never starts playback", () => {
  for (const reason of Object.values(SEEK)) {
    assert.strictEqual(resumesAfterSeek(seeking({ reason, playing: false })), false);
  }
});

test("stepping pauses, because a step is a request to look at one board state", () => {
  assert.strictEqual(resumesAfterSeek(seeking({ reason: SEEK.STEP })), false);
});

test("a mid-drag seek holds playback rather than restarting it per input event", () => {
  assert.strictEqual(resumesAfterSeek(seeking({ reason: SEEK.DRAG })), false);
});

test("seeking to the very end resumes nothing, and does not restart from zero", () => {
  assert.strictEqual(resumesAfterSeek(seeking({ reason: SEEK.JUMP, ms: 10000 })), false);
  assert.strictEqual(resumesAfterSeek(seeking({ reason: SEEK.SCRUB, ms: 99999 })), false);
});

test("seeking to one tick short of the end still carries on playing", () => {
  assert.strictEqual(resumesAfterSeek(seeking({ reason: SEEK.CHAPTER, ms: 9999 })), true);
});

test("an unnamed seek is treated as a scrub, not as a pause", () => {
  assert.strictEqual(resumesAfterSeek(seeking({})), true);
  assert.strictEqual(resumesAfterSeek(null), false, "no seek at all must not resume anything");
});

test("a reason nobody recognises resumes, because resuming is the general rule", () => {
  // Every exemption is named; a reason that is not one of them — a caller from
  // the future, a typo — must land on the rule rather than silently pausing.
  assert.strictEqual(resumesAfterSeek(seeking({ reason: "teleport" })), true);
});

/* The transport's state machine: the resume decision and the drag latch, which
 * have to be decided together. `seekOutcome` is the only thing that assigns the
 * latch, so the table below is the whole of it. */

const moving = (extra) =>
  Object.assign({ playing: false, held: false, finished: false, ms: 1000, total: 10000 }, extra);

test("a drag begun while playing latches, and every later input keeps the latch", () => {
  const first = seekOutcome(moving({ reason: SEEK.DRAG, playing: true }));
  assert.deepStrictEqual(first, { resume: false, held: true }, "the first input holds playback");
  // By the second input the engine is long since stopped, so only the latch is
  // left to say the transport was running.
  const second = seekOutcome(moving({ reason: SEEK.DRAG, held: true, ms: 2000 }));
  assert.deepStrictEqual(second, { resume: false, held: true });
});

test("a drag begun while paused latches nothing, so its release starts nothing", () => {
  assert.deepStrictEqual(seekOutcome(moving({ reason: SEEK.DRAG })), { resume: false, held: false });
});

test("releasing the slider is the seek that reads the latch and resumes", () => {
  assert.deepStrictEqual(seekOutcome(moving({ reason: SEEK.SCRUB, held: true })), {
    resume: true,
    held: false
  });
});

test("releasing the slider on the very end resumes nothing", () => {
  assert.deepStrictEqual(seekOutcome(moving({ reason: SEEK.SCRUB, held: true, ms: 10000 })), {
    resume: false,
    held: false
  });
});

test("a latch left behind by a drag whose end went unseen cannot start playback", () => {
  // Gecko fires `change` only when the value moved, so a drag away and back, or
  // one cancelled with Escape, used to leave the latch set — and the next
  // chapter chip started playing though nobody ever pressed play.
  for (const reason of [SEEK.CHAPTER, SEEK.JUMP, SEEK.STEP]) {
    assert.deepStrictEqual(
      seekOutcome(moving({ reason, held: true })),
      { resume: false, held: false },
      `a stale latch made ${reason} resume`
    );
  }
});

test("any seek that is not a drag clears the latch rather than carrying it on", () => {
  assert.strictEqual(seekOutcome(moving({ reason: SEEK.CHAPTER, held: true })).held, false);
  assert.strictEqual(seekOutcome(moving({ reason: SEEK.SCRUB, held: true })).held, false);
});

test("seeking back into a replay that ran to its end carries on playing from there", () => {
  // The state the core really produces after a finish: stopped, nothing latched,
  // but stopped because it ran out rather than because the viewer asked.
  assert.strictEqual(seekOutcome(moving({ reason: SEEK.CHAPTER, finished: true })).resume, true);
  assert.strictEqual(seekOutcome(moving({ reason: SEEK.JUMP, finished: true, ms: 0 })).resume, true);
});

test("dragging out of a finished replay latches, so the release resumes", () => {
  const held = seekOutcome(moving({ reason: SEEK.DRAG, finished: true })).held;
  assert.strictEqual(held, true);
  assert.strictEqual(seekOutcome(moving({ reason: SEEK.SCRUB, held })).resume, true);
});

test("stepping out of a finished replay stays put, and stepping again still does", () => {
  // The step is the viewer parking the transport, so what it parks on is a
  // deliberate pause: the finish no longer counts for the seeks that follow.
  assert.deepStrictEqual(seekOutcome(moving({ reason: SEEK.STEP, finished: true })), {
    resume: false,
    held: false
  });
});

test("a paused transport stays paused whatever the seek", () => {
  for (const reason of Object.values(SEEK)) {
    assert.deepStrictEqual(
      seekOutcome(moving({ reason })),
      { resume: false, held: false },
      `${reason} started playback from a standing stop`
    );
  }
});

// ---- where a replay opens -----------------------------------------------

test("a replay nobody positioned opens at the start", () => {
  for (const nothing of [undefined, null, 0, -1, NaN, Infinity, "soon"]) {
    assert.strictEqual(startPosition(nothing, 60000), 0, `startPosition(${String(nothing)})`);
  }
});

test("a position inside the recording is kept exactly", () => {
  assert.strictEqual(startPosition(1, 60000), 1);
  assert.strictEqual(startPosition(31500, 60000), 31500);
  assert.strictEqual(startPosition(60000, 60000), 60000);
});

// A link naming 40:00 of a 31-minute replay is not a broken link: it names a
// moment the capture stopped short of. The last frame is a truthful answer to
// that, where an error page in place of a replay that downloaded and decrypted
// perfectly is not.
test("a position past the end lands on the end rather than failing", () => {
  assert.strictEqual(startPosition(2400000, 1860000), 1860000);
  assert.strictEqual(startPosition(60001, 60000), 60000);
});

test("an unusable total opens at the start, whatever was asked for", () => {
  for (const total of [undefined, null, 0, -1, NaN, "long"]) {
    assert.strictEqual(startPosition(5000, total), 0, `total ${String(total)}`);
  }
});

test("autoplay happens only when a surface asked for it", () => {
  assert.strictEqual(shouldAutoplay(true, false), true);
  assert.strictEqual(shouldAutoplay(false, false), false);
  assert.strictEqual(shouldAutoplay(undefined, false), false);
});

test("prefers-reduced-motion overrides a surface that asked to autoplay", () => {
  assert.strictEqual(shouldAutoplay(true, true), false);
});

test("a surface that does not ask opens paused at a named moment", () => {
  // The dashboard's modal, where a moment is a position being examined. A plain
  // link, with no moment named, still plays.
  assert.strictEqual(shouldAutoplay(true, false, true), false);
  assert.strictEqual(shouldAutoplay(true, false, false), true);
});

test("a surface that asks for it plays on from a named moment", () => {
  // The share viewer, where a recipient opening a link someone sent them is
  // starting to watch. Opting in must not disturb the plain-link case either way.
  assert.strictEqual(shouldAutoplay(true, false, true, true), true);
  assert.strictEqual(shouldAutoplay(true, false, false, true), true);
});

test("playing on from a moment can only restore autoplay, never grant it", () => {
  /* The opt-in undoes what naming a moment took away and nothing else. If it
   * could outrank either argument below, a timestamped link would become a way
   * around prefers-reduced-motion - which is exactly the thing the preference
   * is a standing answer to - or a way to start a surface that never asked to
   * play at all. */
  assert.strictEqual(shouldAutoplay(true, true, true, true), false, "reduced motion still wins");
  assert.strictEqual(shouldAutoplay(false, false, true, true), false, "a surface that never asked");
  assert.strictEqual(shouldAutoplay(true, true, false, true), false, "no moment, still reduced");
});

test("naming a moment can only suppress autoplay, never grant it", () => {
  // Unchanged for every surface that does not opt in: still paused *because* a
  // moment was named, not in spite of it.
  assert.strictEqual(shouldAutoplay(true, true, true), false, "reduced motion still wins");
  assert.strictEqual(shouldAutoplay(false, false, true), false, "a surface that never asked");
});

/* ---- who owns a keypress ------------------------------------------------
 *
 * Both viewers hang their shortcuts off a document-level keydown, and both now
 * hold a share link in a focused, selected read-only field and a consent
 * dialogue made of buttons. The rule for which of those keys the transport may
 * take was written twice and drifted four times, so it lives here now and is
 * tested as the decision it is.
 */

const on = (tagName, extra) => Object.assign({ tagName }, extra);

test("text entry owns every key it is given", () => {
  for (const target of [on("TEXTAREA"), on("SELECT"), on("INPUT", { type: "text" }),
    on("INPUT", { type: "search" }), on("DIV", { isContentEditable: true })]) {
    for (const key of [" ", "Spacebar", "ArrowLeft", "ArrowRight", "Home", "End", "f"]) {
      assert.strictEqual(targetOwnsKey(target, key), true, `${target.tagName} must keep ${key}`);
    }
  }
});

/* The one input that does not own the arrows. Its native nudge is a millisecond
 * of a replay minutes long, and moving the range itself would start a drag that
 * no pointer release ever ends. */
test("the seek slider leaves the arrows to the transport", () => {
  const slider = on("INPUT", { type: "range" });
  for (const key of [" ", "ArrowLeft", "ArrowRight", "Home", "End"]) {
    assert.strictEqual(targetOwnsKey(slider, key), false, `the slider must not swallow ${key}`);
  }
});

/* Space is how a focused button is pressed, and this branch put "Create share
 * link" and "Cancel" on the only path to a consented upload. Nothing else about
 * a button is its own: the transport keeps the arrows so a viewer who has just
 * clicked Next can carry on with the keyboard. */
test("a focused button owns space, and only space", () => {
  const button = on("BUTTON");
  assert.strictEqual(targetOwnsKey(button, " "), true);
  assert.strictEqual(targetOwnsKey(button, "Spacebar"), true, "the legacy key name counts too");
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "f", "Escape"]) {
    assert.strictEqual(targetOwnsKey(button, key), false, `a button does not own ${key}`);
  }
});

test("the replay itself, and a missing target, own nothing", () => {
  for (const target of [on("DIV"), on("IFRAME"), on("BODY"), null, undefined, {}]) {
    assert.strictEqual(targetOwnsKey(target, " "), false, JSON.stringify(target));
    assert.strictEqual(targetOwnsKey(target, "ArrowRight"), false, JSON.stringify(target));
  }
});

/* ── stripInertLinks ──────────────────────────────────────────────────────────
 *
 * The recorder captures documentElement, so the game's whole <head> rides along
 * in every keyframe: favicons the viewer's img-src refuses, preloads nothing
 * consumes. Stripping them is easy; stripping one node too many is the
 * expensive mistake, because a <link> that was going to become a <style> takes
 * the entire stylesheet with it and the replay plays unstyled with no error at
 * all. Every "kept" case below is guarding that.
 */

const link = (attributes) => ({ type: 2, tagName: "link", attributes, id: 40 });

/** A full snapshot with `headChildren` in <head>, three levels deep. */
function headSnapshot(headChildren, timestamp = 1000) {
  return {
    type: FULL_SNAPSHOT,
    timestamp,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            tagName: "html",
            attributes: { lang: "en" },
            id: 2,
            childNodes: [
              { type: 2, tagName: "head", attributes: {}, id: 3, childNodes: headChildren },
              { type: 2, tagName: "body", attributes: {}, id: 4, childNodes: [] }
            ]
          }
        ]
      }
    }
  };
}

/** The <head> children of the first event's snapshot tree. */
const headOf = (events) => events[0].data.node.childNodes[0].childNodes[0].childNodes;

test("the icons the viewer's CSP refuses are stripped", () => {
  for (const rel of ["icon", "shortcut icon", "apple-touch-icon",
    "apple-touch-icon-precomposed", "mask-icon"]) {
    const events = stripInertLinks([headSnapshot([link({ rel, href: "/favicon.ico" })])]);
    assert.deepEqual(headOf(events), [], `rel="${rel}" is fetched from the game's origin for nobody`);
  }
});

test("the preload family is stripped", () => {
  for (const rel of ["preload", "modulepreload", "prefetch", "preconnect", "dns-prefetch", "manifest"]) {
    const events = stripInertLinks([headSnapshot([link({ rel, href: "/effects/clock.webp" })])]);
    assert.deepEqual(headOf(events), [], `rel="${rel}" reaches the network and renders nothing`);
  }
});

test("rel is matched by token, in any case and any order", () => {
  const events = stripInertLinks([headSnapshot([
    link({ rel: "SHORTCUT ICON", href: "/favicon.ico" }),
    link({ rel: "icon  shortcut", href: "/favicon.ico" })
  ])]);
  assert.deepEqual(headOf(events), []);
});

test("a stylesheet whose text is still inline is kept", () => {
  const sheet = link({ rel: "stylesheet", href: "/app.css", _cssText: ".board{color:red}" });
  const events = stripInertLinks([headSnapshot([sheet])]);
  assert.deepEqual(headOf(events), [sheet], "rrweb turns this into a <style>; dropping it unstyles the replay");
});

test("a stylesheet reduced to a __cssRef is kept", () => {
  const sheet = link({ rel: "stylesheet", href: "/app.css", __cssRef: "h4096" });
  const events = stripInertLinks([headSnapshot([sheet])]);
  assert.deepEqual(headOf(events), [sheet], "the viewer rehydrates this ref back into _cssText");
});

/* The belt to the braces above: the rel says "drop me", the payload says
 * "I am a stylesheet". The payload wins, so no unusual, absent or mistaken rel
 * can cost a sheet. */
test("a node carrying stylesheet text is kept whatever its rel claims", () => {
  for (const carrier of [{ _cssText: ".a{}" }, { __cssRef: "h1" }, { _cssText: "" }, { __cssRef: "" }]) {
    const sheet = link(Object.assign({ rel: "preload", as: "style", href: "/app.css" }, carrier));
    const events = stripInertLinks([headSnapshot([sheet])]);
    assert.deepEqual(headOf(events), [sheet], JSON.stringify(carrier));
  }
});

test("a <link> with no rel, an unknown rel, or a partly-inert rel is kept", () => {
  const kept = [
    link({ href: "/mystery" }),
    link({ rel: "", href: "/mystery" }),
    link({ rel: "stylesheet", href: "/app.css" }),
    link({ rel: "canonical", href: "https://play.riftatlas.com/" }),
    link({ rel: "alternate stylesheet", href: "/dark.css" }),
    link({ rel: "preload stylesheet", href: "/app.css" })
  ];
  const events = stripInertLinks([headSnapshot(kept.slice())]);
  assert.deepEqual(headOf(events), kept);
});

test("only <link> elements are candidates", () => {
  const kept = [
    { type: 2, tagName: "meta", attributes: { rel: "icon" }, id: 50 },
    { type: 2, tagName: "style", attributes: { _cssText: ".a{}" }, id: 51 },
    { type: 3, textContent: "icon", id: 52 }
  ];
  const events = stripInertLinks([headSnapshot(kept.slice())]);
  assert.deepEqual(headOf(events), kept);
});

test("inert links are stripped wherever they sit in the tree", () => {
  const keeper = link({ rel: "stylesheet", href: "/app.css", _cssText: ".a{}" });
  const deep = {
    type: 2,
    tagName: "div",
    attributes: { id: "board" },
    id: 60,
    childNodes: [
      link({ rel: "preload", as: "image", href: "/card.webp" }),
      { type: 2, tagName: "span", attributes: {}, id: 61, childNodes: [link({ rel: "icon" })] }
    ]
  };
  const events = stripInertLinks([headSnapshot([keeper, deep])]);
  const head = headOf(events);

  assert.deepEqual(head[0], keeper);
  assert.deepEqual(head[1].childNodes, [
    { type: 2, tagName: "span", attributes: {}, id: 61, childNodes: [] }
  ]);
});

test("every full snapshot is scrubbed, not just the first", () => {
  const events = stripInertLinks([
    headSnapshot([link({ rel: "icon" })], 1000),
    mutation(1500),
    headSnapshot([link({ rel: "icon" })], 2000)
  ]);
  assert.deepEqual(headOf(events), []);
  assert.deepEqual(events[2].data.node.childNodes[0].childNodes[0].childNodes, []);
});

/* Identity, as store/css-assets.js does it: a stream with nothing to strip is
 * the same array, holding the same events, holding the same nodes. Replays run
 * to tens of megabytes, and cloning one to change nothing is pure cost. */
test("a stream with nothing to strip is returned by reference", () => {
  const events = [
    headSnapshot([link({ rel: "stylesheet", href: "/app.css", _cssText: ".a{}" })]),
    mutation(1500)
  ];
  assert.strictEqual(stripInertLinks(events), events);
});

test("untouched events and untouched subtrees keep their identity", () => {
  const clean = headSnapshot([link({ rel: "stylesheet", _cssText: ".a{}" })], 1000);
  const dirty = headSnapshot([link({ rel: "icon" })], 2000);
  const body = dirty.data.node.childNodes[0].childNodes[1];

  const events = stripInertLinks([clean, dirty]);
  assert.notStrictEqual(events, [clean, dirty]);
  assert.strictEqual(events[0], clean, "an event with nothing to strip is not rebuilt");
  assert.notStrictEqual(events[1], dirty);
  assert.strictEqual(
    events[1].data.node.childNodes[0].childNodes[1],
    body,
    "<body> is where the replay is; it must not be cloned to strip a favicon"
  );
});

test("a stream that is not an array, or carries no snapshot, is handed back", () => {
  for (const events of [null, undefined, "nope", { length: 1 }]) {
    assert.strictEqual(stripInertLinks(events), events);
  }
  const odd = [{ type: 3, timestamp: 1, data: {} }, null, { timestamp: 2 }];
  assert.strictEqual(stripInertLinks(odd), odd);
});

test("the drop list holds nothing that can render", () => {
  // A rel that paints, or that a browser resolves into content, must never be
  // on this list. `alternate` is the trap: "alternate stylesheet" is a sheet.
  for (const rel of ["stylesheet", "alternate", "canonical", "author", "license", "next", "prev"]) {
    assert.equal(INERT_LINK_RELS.includes(rel), false, `rel="${rel}" must not be dropped`);
  }
  assert.equal(isInertLink(link({ rel: "stylesheet" })), false);
});

// ---- playback speed ----------------------------------------------------

test("the speed list is sorted, includes 1x, and is frozen", () => {
  // A missing 1x would leave no way back to real time.
  assert.ok(SPEEDS.includes(1));
  assert.deepEqual([...SPEEDS].sort((a, b) => a - b), [...SPEEDS], "slowest first");
  assert.ok(Object.isFrozen(SPEEDS));
});

test("both viewers build their speed control from the list, rather than restating it", () => {
  /* The claim this file used to make about "both viewers read it" was checked
   * nowhere, and the share viewer did not: index.html spelled the five options
   * out again, so the two surfaces were one edit away from offering different
   * speeds. Read the sources and hold it. */
  const fs = require("node:fs");
  const path = require("node:path");
  const at = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

  const builders = ["dashboard/replay-html.js", "share/worker/public/viewer.js"];
  for (const file of builders) {
    assert.match(at(file), /SPEEDS\.map\(/, `${file} must build its options from SPEEDS`);
  }

  /* The markup carries an empty select. Anchored on the id so this fails if the
   * control is renamed rather than passing over a page that no longer has one. */
  const html = at("share/worker/public/index.html");
  const select = html.match(/<select[^>]*id="speed"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select, "index.html no longer has a select#speed for viewer.js to fill");
  assert.equal(select[1].trim(), "", "the options belong to SPEEDS, not to the markup");
});

test("unreadable speeds fall back to 1x rather than guessing", () => {
  for (const bad of [null, undefined, NaN, "fast", 0, -2]) {
    assert.equal(normaliseSpeed(bad), 1, `${String(bad)} must play at real time`);
  }
});

test("readable speeds are clamped to the range the controls offer", () => {
  assert.equal(normaliseSpeed(0.1), SPEEDS[0]);
  assert.equal(normaliseSpeed(100), SPEEDS[SPEEDS.length - 1]);
  assert.equal(normaliseSpeed(2), 2);
  assert.equal(normaliseSpeed("4"), 4, "control values arrive as strings");
});

/* --- hasPointerData ---------------------------------------------------- */

/* rrweb mounts its cursor whether or not the recording ever watched one, so a
 * capture from before pointer recording was turned on shows an arrow parked in
 * the corner for the whole match - a player who never moved, rather than a
 * recording that never looked. replay-core.js hides the element when this says
 * no, which makes a wrong answer here either a cursor missing from every new
 * replay or a fake one back on every old one. Neither throws. */

const incremental = (source) => ({ type: 3, timestamp: 1000, data: { source } });

test("a stream with mouse movement carries pointer data", () => {
  const events = [{ type: 2, timestamp: 0, data: {} }, incremental(0), incremental(1)];
  assert.equal(hasPointerData(events), true);
});

test("clicks alone count: a player who moved nothing still clicked", () => {
  assert.equal(hasPointerData([incremental(0), incremental(2)]), true);
});

test("touch movement counts, since a tablet's cursor is the touch point", () => {
  assert.equal(hasPointerData([incremental(6)]), true);
});

test("mutation and scroll traffic is not pointer data", () => {
  // Source 3 is Scroll, which a keyboard produces as readily as a mouse, and
  // source 5 is Input. Neither says anything about where a cursor was.
  const events = [
    { type: 4, timestamp: 0, data: {} },
    incremental(0), incremental(3), incremental(5),
    { type: 5, timestamp: 1, data: { tag: "ra:turn" } },
  ];
  assert.equal(hasPointerData(events), false);
});

test("an absent or empty stream carries no pointer data rather than throwing", () => {
  assert.equal(hasPointerData([]), false);
  assert.equal(hasPointerData(null), false);
  assert.equal(hasPointerData([null, undefined, {}]), false);
});
