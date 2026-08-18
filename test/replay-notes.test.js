/* Timestamped replay notes: the model, the one write, and the drawer driven.
 *
 * Three things here fail silently when they are wrong, which is why each has
 * its own section below.
 *
 *   - THE MODEL. A note with no text, or with a position that is not a number,
 *     renders as a row that says nothing and seeks nowhere. A duplicate id -
 *     which nothing this build writes, and any hand-edited export might - makes
 *     one delete take two notes with it. Both come out of a file the dashboard
 *     had no part in writing, so `notesOf` is the boundary and it is checked
 *     over what an import can actually contain.
 *   - THE WRITE. Notes live on the match record, which is the array `Archive &
 *     clear` empties and Export JSON carries. A write that misses the archive's
 *     veto edits a file the viewer was promised was read-only.
 *   - THE DRAWER, which is all wiring: the pin is taken when the writing starts
 *     rather than when Save is pressed, and nothing about that is decidable
 *     from data. So it is driven for real - the shipped playback core, the
 *     shipped transport row, the shipped chrome - against a fake rrweb and the
 *     parsed-markup page test/fake-page.js already gives the boot test.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { loadPage, element } = require("./fake-page.js");
const N = require("../dashboard/replay-notes.js");

const repo = path.join(__dirname, "..");
const readSrc = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");

// ---- the model ---------------------------------------------------------

test("a note is text pinned to a millisecond, and anything else is not one", () => {
  assert.deepEqual(N.cleanNote({ atMs: 1200, text: " kept the wrong hand " }), {
    id: "",
    atMs: 1200,
    text: "kept the wrong hand",
  });
  // Each of these renders as a row that says nothing, or seeks nowhere.
  for (const bad of [
    null,
    "note",
    { atMs: 1200, text: "   " },
    { atMs: 1200 },
    { atMs: -1, text: "before the start" },
    { atMs: NaN, text: "nowhere" },
    { atMs: "soon", text: "nowhere" },
  ]) {
    assert.equal(N.cleanNote(bad), null, JSON.stringify(bad));
  }
});

test("a note is capped in length, because it rides on the live match array", () => {
  const long = N.cleanNote({ atMs: 0, text: "x".repeat(N.MAX_TEXT + 40) });
  assert.equal(long.text.length, N.MAX_TEXT);
});

test("notes come back in playback order, whatever order they were stored in", () => {
  const list = N.notesOf({ timedNotes: [
    { id: "n2", atMs: 90000, text: "late" },
    { id: "n1", atMs: 1000, text: "early" },
  ] });
  assert.deepEqual(list.map((n) => n.text), ["early", "late"]);
});

test("two notes on the same moment keep the order they were written in", () => {
  const list = N.notesOf({ timedNotes: [
    { id: "n1", atMs: 5000, text: "first" },
    { id: "n2", atMs: 5000, text: "second" },
  ] });
  assert.deepEqual(list.map((n) => n.text), ["first", "second"]);
});

test("a match with no notes, or junk where its notes should be, has none", () => {
  for (const m of [{}, { timedNotes: null }, { timedNotes: "notes" }, null]) {
    assert.deepEqual(N.notesOf(m), []);
  }
  assert.deepEqual(N.notesOf({ timedNotes: [{ atMs: 1, text: "" }, 7] }), []);
});

test("ids repeated by an imported file are repaired, or one delete takes two notes", () => {
  const list = N.notesOf({ timedNotes: [
    { id: "n1", atMs: 1000, text: "first" },
    { id: "n1", atMs: 2000, text: "second" },
    { atMs: 3000, text: "no id at all" },
  ] });
  assert.equal(new Set(list.map((n) => n.id)).size, 3, "every note must be addressable on its own");
  const left = N.removeNote(list, list[0].id);
  assert.deepEqual(left.map((n) => n.text), ["second", "no id at all"]);
});

test("a stored list past the cap is read back at the cap", () => {
  const many = Array.from({ length: N.MAX_NOTES + 25 }, (_, i) => ({ atMs: i * 10, text: "n" + i }));
  assert.equal(N.notesOf({ timedNotes: many }).length, N.MAX_NOTES);
});

test("the next id is one past the highest the list already carries", () => {
  assert.equal(N.nextId([]), "n1");
  assert.equal(N.nextId([{ id: "n1" }, { id: "n7" }, { id: "n2" }]), "n8");
  // Ids from somewhere else entirely must not make the counter start over.
  assert.equal(N.nextId([{ id: "kept" }]), "n1");
});

test("adding a note lands it in playback order with an id of its own", () => {
  const first = N.addNote([], 9000, "late note");
  const second = N.addNote(first.list, 1000, "early note");
  assert.deepEqual(second.list.map((n) => n.text), ["early note", "late note"]);
  assert.deepEqual(second.list.map((n) => n.id), ["n2", "n1"]);
  assert.equal(second.error, null);
});

test("a note with nothing in it is refused, with something to say about it", () => {
  const result = N.addNote([], 1000, "   ");
  assert.equal(result.note, null);
  assert.match(result.error, /text/i);
  assert.deepEqual(result.list, []);
});

test("the cap on notes per match is refused rather than silently dropped", () => {
  let list = [];
  for (let i = 0; i < N.MAX_NOTES; i++) list = N.addNote(list, i, "note " + i).list;
  const over = N.addNote(list, 999999, "one too many");
  assert.equal(over.note, null);
  assert.match(over.error, new RegExp(String(N.MAX_NOTES)));
  assert.equal(over.list.length, N.MAX_NOTES);
});

test("deleting a note that is already gone writes nothing", () => {
  const list = N.addNote([], 1000, "here").list;
  assert.equal(N.removeNote(list, "n9"), list, "the same array means nothing to write");
  assert.deepEqual(N.removeNote(list, "n1"), []);
});

test("re-wording a note keeps its moment, and emptying one deletes it", () => {
  const list = N.addNote([], 4000, "first go").list;
  const edited = N.editNote(list, "n1", "second go");
  assert.deepEqual(edited.list, [{ id: "n1", atMs: 4000, text: "second go" }]);
  assert.deepEqual(N.editNote(list, "n1", "   ").list, [], "an empty note is not a note");
  assert.match(N.editNote(list, "n9", "nowhere").error, /no longer here/);
});

test("a marker sits where its note does, and nowhere at all without a length", () => {
  assert.equal(N.markerAt(0, 1000), 0);
  assert.equal(N.markerAt(500, 1000), 50);
  // A note can outlive the recording it was written against: retention deletes
  // replays, and a shorter one can be captured for the same match afterwards.
  assert.equal(N.markerAt(4000, 1000), 100);
  for (const total of [0, -1, null, NaN, undefined]) assert.equal(N.markerAt(10, total), null);
});

// ---- the one write -----------------------------------------------------

/** The store, mounted over a match array a test can look inside afterwards. */
function store(options = {}) {
  const matches = options.matches || [{ id: "m1" }];
  const writes = [];
  N.mount({
    matches: () => matches,
    readOnly: () => !!options.readOnly,
    persist: (next) => writes.push(next),
  });
  return { matches, writes, match: () => matches[0] };
}

test("a note is written onto the match record, where an export will carry it", () => {
  const s = store();
  N.add("m1", 12000, "traded too early");
  assert.equal(s.writes.length, 1, "one write of the match array");
  assert.deepEqual(s.match().timedNotes, [{ id: "n1", atMs: 12000, text: "traded too early" }]);
});

test("the last note off a match takes the field with it, not an empty array", () => {
  const s = store();
  N.add("m1", 3000, "one");
  assert.equal(N.remove("m1", "n1"), true);
  assert.equal("timedNotes" in s.match(), false, "an empty array is bytes on the live array");
});

test("an archive is read-only, and that includes its notes", () => {
  const s = store({ readOnly: true, matches: [{ id: "m1", timedNotes: [{ id: "n1", atMs: 1, text: "kept" }] }] });
  assert.match(N.add("m1", 2000, "new").error, /read-only/i);
  assert.equal(N.remove("m1", "n1"), false);
  assert.match(N.edit("m1", "n1", "changed").error, /read-only/i);
  assert.deepEqual(s.writes, [], "nothing may be written while a file is open");
  assert.equal(s.match().timedNotes.length, 1);
  assert.equal(N.hooksFor("m1"), null, "and the modal gets no composer at all");
});

test("a note aimed at a match that is no longer here writes nothing", () => {
  const s = store();
  assert.match(N.add("gone", 1000, "orphan").error, /no longer here/);
  assert.equal(N.remove("gone", "n1"), false);
  assert.deepEqual(s.writes, []);
});

test("the hooks the modal is handed read the list back after every write", () => {
  const s = store();
  const hooks = N.hooksFor("m1");
  hooks.add(1000, "first");
  hooks.add(500, "second");
  assert.deepEqual(hooks.list().map((n) => n.text), ["second", "first"]);
  hooks.remove(hooks.list()[0].id);
  assert.deepEqual(hooks.list().map((n) => n.text), ["first"]);
  hooks.edit(hooks.list()[0].id, "first, reworded");
  assert.deepEqual(hooks.list().map((n) => n.text), ["first, reworded"]);
  assert.equal(s.writes.length, 4);
});

// ---- the drawer, driven -------------------------------------------------

/* rrweb, as much of it as the playback core touches. The core is shipped code
 * and runs here for real; what it drives is this. */
function fakeReplayer() {
  const box = () => ({ style: {}, setAttribute() {} });
  return class Replayer {
    constructor() {
      this.wrapper = box();
      this.iframe = box();
      this.at = 0;
      this.playing = false;
      this.handlers = {};
    }
    getMetaData() {
      return { totalTime: 600000 };
    }
    getCurrentTime() {
      return this.at;
    }
    play(ms) {
      if (ms !== undefined) this.at = ms;
      this.playing = true;
    }
    pause(ms) {
      if (ms !== undefined) this.at = ms;
      this.playing = false;
    }
    setConfig() {}
    on(type, fn) {
      this.handlers[type] = fn;
    }
    destroy() {}
  };
}

/** The modal's viewer, mounted into a bare container with a notes handler. */
function drawer(options = {}) {
  const page = loadPage("<html><body><div class='rp-modal-body'></div></body></html>");
  const warnings = [];
  const Replayer = fakeReplayer();
  const sandbox = {
    document: page.document,
    console: { warn: (...a) => warnings.push(a.join(" ")), error: (...a) => warnings.push(a.join(" ")) },
    rrwebReplay: { Replayer },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
    Date,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const rel of [
    "dashboard/format.js",
    "replay/replay-timeline.js",
    "replay/replay-core.js",
    "replay/replay-transport.js",
    "dashboard/replay-notes.js",
    "dashboard/replay-html.js",
  ]) {
    vm.runInContext(readSrc(rel), context, { filename: rel });
  }

  const matches = [{ id: "m1" }];
  const writes = [];
  sandbox.RATrackerReplayNotes.mount({
    matches: () => matches,
    readOnly: () => false,
    persist: () => writes.push(1),
  });

  const t0 = 1770000000000;
  const events = [
    { type: 4, timestamp: t0 },
    { type: 2, timestamp: t0, data: {} },
    { type: 3, timestamp: t0 + 300000, data: {} },
  ];
  const container = page.document.querySelector(".rp-modal-body");
  const ctl = sandbox.RATrackerVisualReplay.mount(
    container,
    matches[0],
    { meta: {}, events },
    Object.assign({ notes: sandbox.RATrackerReplayNotes.hooksFor("m1") }, options)
  );

  const at = (selector) => container.querySelector(selector);
  return {
    ctl,
    container,
    warnings,
    matches,
    writes,
    at,
    /* Plain objects: the list is built inside the vm's realm, so its arrays
     * and objects have that realm's prototypes and no deep-equal against a
     * literal written out here would ever match them. */
    notes: () => JSON.parse(JSON.stringify(sandbox.RATrackerReplayNotes.notesOf(matches[0]))),
    fire: (el, type) => page.dispatch(el, type),
  };
}

test("the drawer is drawn, hidden, with a toggle beside the transport", () => {
  const d = drawer();
  assert.ok(d.ctl, "the viewer must have started");
  assert.equal(d.at(".vr-notes").hidden, true, "it is a drawer, not a panel that is always open");
  assert.ok(d.at(".vr-notes-btn"), "and there is something to open it with");
  d.at(".vr-notes-btn").click();
  assert.equal(d.at(".vr-notes").hidden, false);
  assert.equal(d.at(".vr-notes-btn").getAttribute("aria-pressed"), "true");
  assert.deepEqual(d.warnings, []);
});

test("a modal opened without a notes handler has no drawer rather than a dead one", () => {
  const d = drawer({ notes: null });
  assert.equal(d.at(".vr-notes"), null);
  assert.equal(d.at(".vr-notes-btn"), null);
});

test("writing a note pauses the replay and pins the note to where it stopped", () => {
  const d = drawer();
  d.at(".vr-notes-btn").click();
  // Somewhere into the match, playing, exactly as a viewer would be.
  d.ctl.handleKey({ key: " ", target: {}, preventDefault() {} });
  d.at(".vr-slider").value = "120000";
  d.fire(d.at(".vr-slider"), "input");

  d.fire(d.at(".vr-notes-draft"), "focus");
  assert.equal(d.at(".vr-notes-when").textContent, "2:00", "the pin is the moment writing started");

  // The replay carries on for another two minutes' worth of clock while the
  // sentence is typed, and the note must not follow it.
  d.at(".vr-slider").value = "240000";
  d.fire(d.at(".vr-slider"), "input");
  assert.equal(d.at(".vr-notes-when").textContent, "2:00");

  d.at(".vr-notes-draft").value = "traded the wrong unit here";
  d.at(".vr-notes-save").click();

  assert.deepEqual(d.notes(), [{ id: "n1", atMs: 120000, text: "traded the wrong unit here" }]);
  assert.equal(d.at(".vr-notes-draft").value, "", "the box is emptied for the next one");
  assert.ok(d.at(".vr-notes-list").textContent.includes("traded the wrong unit here"));
  assert.ok(d.at(".vr-notes-seek"), "and the saved note is a seek back to its moment");
  assert.ok(d.at(".vr-mark"), "and a marker on the scrubber");
  assert.deepEqual(d.warnings, []);
});

test("a note with nothing in it says so instead of being written", () => {
  const d = drawer();
  d.at(".vr-notes-btn").click();
  d.at(".vr-notes-save").click();
  assert.deepEqual(d.notes(), []);
  assert.equal(d.at(".vr-notes-error").hidden, false);
  assert.match(d.at(".vr-notes-error").textContent, /text/i);
});

test("a saved note seeks the replay back to its own moment", () => {
  const d = drawer();
  d.at(".vr-notes-btn").click();
  d.at(".vr-slider").value = "90000";
  d.fire(d.at(".vr-slider"), "input");
  d.fire(d.at(".vr-notes-draft"), "focus");
  d.at(".vr-notes-draft").value = "this is the moment";
  d.at(".vr-notes-save").click();

  d.at(".vr-slider").value = "300000";
  d.fire(d.at(".vr-slider"), "input");
  d.at(".vr-notes-seek").click();
  assert.equal(d.at(".vr-time").textContent.split(" / ")[0], "1:30");
});

test("deleting a note from the drawer takes it off the match", () => {
  const d = drawer();
  d.at(".vr-notes-btn").click();
  d.fire(d.at(".vr-notes-draft"), "focus");
  d.at(".vr-notes-draft").value = "gone in a moment";
  d.at(".vr-notes-save").click();
  assert.equal(d.notes().length, 1);

  d.at(".vr-notes-del").click();
  assert.deepEqual(d.notes(), []);
  assert.equal(d.at(".vr-notes-del"), null, "and the row goes with it");
  assert.ok(d.at(".vr-notes-list").textContent.includes("No notes"));
});

test("Escape belongs to a half-written note before it belongs to the modal", () => {
  const d = drawer();
  d.at(".vr-notes-btn").click();
  assert.equal(d.ctl.escapeHandled(), false, "with nothing being written, Escape closes as it always did");

  d.fire(d.at(".vr-notes-draft"), "focus");
  d.at(".vr-notes-draft").value = "half a thought";
  assert.equal(d.ctl.escapeHandled(), true, "the first Escape drops the draft");
  assert.equal(d.at(".vr-notes-draft").value, "");
  assert.equal(d.ctl.escapeHandled(), false, "the second closes the window");
});

test("a note's timestamp opens the replay there, with the drawer it came from", () => {
  // What the Matches view's summary asks for: a moment by name, which the core
  // opens at and holds still on.
  const d = drawer({ startAtMs: 45000, openNotes: true });
  assert.equal(d.at(".vr-notes").hidden, false);
  assert.equal(d.at(".vr-time").textContent.split(" / ")[0], "0:45");
});
