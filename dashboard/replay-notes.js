/* Rift Atlas Stats Tracker - timestamped replay notes
 *
 * A note is a line of text pinned to a millisecond of a match's replay: "kept
 * the wrong hand here", "should have contested mid". They are written while
 * watching, from the drawer in the replay modal, and read back two ways - as
 * markers on that replay's scrubber, and as a summary in the match's expanded
 * row, where each timestamp opens the replay at the moment it names.
 *
 * WHERE THEY LIVE. On the match record, as `timedNotes`, beside the free-text
 * `notes` field that has always been there. That is the same call the research
 * doc made when it ranked this feature, and it buys three things for nothing:
 * Export JSON carries them, Import JSON merges them back, and an archive file
 * opens with them intact. A `notes_<id>` key of their own would need wiring in
 * all three places and would still be lost by every export written before it.
 * The cost is bytes on the array rewritten during a live game, which is why
 * the text is capped, the count is capped, and an empty list is deleted rather
 * than stored.
 *
 * They are NOT part of a share. A share is a replay handed to someone else and
 * a note is what you thought while watching it; the payload, the frame and the
 * Worker are all untouched by this file.
 *
 * The half above `mount` is pure and is what test/replay-notes.test.js holds:
 * every decision that can be made from a list and a string alone - what counts
 * as a note, which id the next one gets, what a stored list is worth when it
 * came out of a hand-edited file. The half below it is the one write path, and
 * it goes through the dashboard's single writer like every other.
 */
(function (root) {
  "use strict";

  /* Caps, in the order they bite. Text first: a note is a reminder, not a
   * report, and the record it rides on is rewritten every three seconds while a
   * match is live. Count second: 200 notes is far past any real review and is
   * what stops a stuck key turning one match into a megabyte. Both are enforced
   * on the way in AND on the way back out, because a record can arrive from an
   * imported file that this build never wrote. */
  const MAX_TEXT = 500;
  const MAX_NOTES = 200;

  /** The text a note is stored with, or "" for anything that is not one. */
  function cleanText(text) {
    if (typeof text !== "string") return "";
    return text.trim().slice(0, MAX_TEXT);
  }

  /**
   * One stored entry, normalised, or null if there is no note in it.
   *
   * A note with no text is not a note - it would render as an empty row with a
   * timestamp and no way to tell what it meant - and a position that is not a
   * finite number of milliseconds cannot be seeked to.
   */
  function cleanNote(raw) {
    if (!raw || typeof raw !== "object") return null;
    const atMs = Number(raw.atMs);
    if (!Number.isFinite(atMs) || atMs < 0) return null;
    const text = cleanText(raw.text);
    if (!text) return null;
    return { id: typeof raw.id === "string" && raw.id ? raw.id : "", atMs: Math.round(atMs), text };
  }

  /**
   * A match's notes: normalised, uniquely identified, in playback order.
   *
   * Sorted by position rather than by when they were written, because the list
   * is read against a timeline in both places it appears. The sort is stable,
   * so two notes on the same millisecond keep the order they were added in.
   *
   * Ids are repaired here rather than trusted. Nothing this build writes lacks
   * one or repeats one, but an imported file is whatever someone's editor left
   * behind, and a duplicate id would make one delete take two notes with it.
   */
  function notesOf(match) {
    const stored = match && Array.isArray(match.timedNotes) ? match.timedNotes : [];
    const seen = new Set();
    const out = [];
    for (const raw of stored) {
      const note = cleanNote(raw);
      if (!note) continue;
      if (!note.id || seen.has(note.id)) note.id = nextId(out);
      seen.add(note.id);
      out.push(note);
      if (out.length >= MAX_NOTES) break;
    }
    return out.sort((a, b) => a.atMs - b.atMs);
  }

  /**
   * The id the next note gets: one past the highest this list already carries.
   *
   * Counted rather than clocked or randomised, so adding a note is decidable
   * from the list alone and the tests need no fake timer. Ids only have to be
   * unique within one match, which is the only scope anything resolves them in.
   */
  function nextId(list) {
    let highest = 0;
    for (const note of list || []) {
      const n = /^n(\d+)$/.exec((note && note.id) || "");
      if (n && Number(n[1]) > highest) highest = Number(n[1]);
    }
    return "n" + (highest + 1);
  }

  /**
   * `list` with a note added at `atMs`, or the reason there is no such list.
   *
   * The list comes back new and sorted; the caller writes it whole. `error` is
   * the sentence the UI shows, and is null exactly when `note` is not.
   */
  function addNote(list, atMs, text) {
    const current = list || [];
    const clean = cleanNote({ atMs, text });
    if (!clean) {
      return { list: current, note: null, error: "A note needs some text." };
    }
    if (current.length >= MAX_NOTES) {
      return {
        list: current,
        note: null,
        error: `This match already has ${MAX_NOTES} notes, which is the limit.`,
      };
    }
    clean.id = nextId(current);
    return {
      list: current.concat([clean]).sort((a, b) => a.atMs - b.atMs),
      note: clean,
      error: null,
    };
  }

  /**
   * `list` without `id`. The same array comes back when nothing matched, so a
   * delete of something already gone writes nothing.
   */
  function removeNote(list, id) {
    const current = list || [];
    const next = current.filter((note) => note.id !== id);
    return next.length === current.length ? current : next;
  }

  /**
   * `list` with `id` re-worded. Clearing a note's text is a delete: an empty
   * note is not a thing this file will store, and leaving the row there with
   * nothing in it would be worse than either.
   */
  function editNote(list, id, text) {
    const current = list || [];
    const clean = cleanText(text);
    if (!clean) return { list: removeNote(current, id), error: null };
    let found = false;
    const next = current.map((note) => {
      if (note.id !== id) return note;
      found = true;
      return { id: note.id, atMs: note.atMs, text: clean };
    });
    return { list: found ? next : current, error: found ? null : "That note is no longer here." };
  }

  /**
   * Where a note sits on a scrubber, as a percentage of the recording.
   *
   * Null when there is no recording length to measure against - a marker drawn
   * from a total of zero would sit at the left-hand end and claim to mean
   * something. Clamped, because a note can outlive the recording it was written
   * against: deleting a replay leaves the notes on the match, and a later
   * capture of the same match is not obliged to be as long.
   */
  function markerAt(atMs, totalMs) {
    const total = Number(totalMs);
    const at = Number(atMs);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(at)) return null;
    return Math.min(100, Math.max(0, (at / total) * 100));
  }

  // ---- the one write path -------------------------------------------------

  /* Supplied by mount(), from legacy.js, which owns the match array and the
   * only writer. Same arrangement as every view drained out of that file: this
   * one holds the rules, that one holds the data. */
  let matches = () => [];
  let readOnly = () => false;
  let persist = () => {};

  function mount(deps) {
    matches = deps.matches;
    readOnly = deps.readOnly;
    persist = deps.persist;
  }

  const matchById = (matchId) => matches().find((m) => m && m.id === matchId) || null;

  /** A match's notes, ready to render. Empty for a match that has none. */
  const listFor = (matchId) => notesOf(matchById(matchId));

  /**
   * Write a list back onto its match.
   *
   * An empty list is deleted rather than stored: `all` is the array rewritten
   * every few seconds during a live match, and an empty array per match is
   * bytes that say exactly what their absence says.
   */
  function write(match, list) {
    if (list.length) match.timedNotes = list;
    else delete match.timedNotes;
    persist(matches());
  }

  /** Add a note to a match. `{ note, error }`, exactly one of them set. */
  function add(matchId, atMs, text) {
    const match = matchById(matchId);
    if (!match) return { note: null, error: "That match is no longer here." };
    if (readOnly()) return { note: null, error: "An archive is read-only." };
    const result = addNote(notesOf(match), atMs, text);
    if (result.note) write(match, result.list);
    return { note: result.note, error: result.error };
  }

  /** Delete one note. True when something was actually written. */
  function remove(matchId, noteId) {
    const match = matchById(matchId);
    if (!match || readOnly()) return false;
    const current = notesOf(match);
    const next = removeNote(current, noteId);
    if (next === current) return false;
    write(match, next);
    return true;
  }

  /** Re-word one note; clearing it deletes it. `{ error }`. */
  function edit(matchId, noteId, text) {
    const match = matchById(matchId);
    if (!match) return { error: "That match is no longer here." };
    if (readOnly()) return { error: "An archive is read-only." };
    const result = editNote(notesOf(match), noteId, text);
    if (!result.error) write(match, result.list);
    return { error: result.error };
  }

  /**
   * What the replay modal is handed for one match, or null while an archive is
   * open - the modal draws no composer at all rather than a dead one, which is
   * the same answer `renderShell` gives a caller with no share handler.
   *
   * A closure per match id, because the modal has one match and no way to reach
   * the match array; and it re-reads the list on every call rather than holding
   * one, since a write replaces the array underneath it.
   */
  function hooksFor(matchId) {
    if (readOnly()) return null;
    return {
      list: () => listFor(matchId),
      add: (atMs, text) => add(matchId, atMs, text),
      remove: (noteId) => remove(matchId, noteId),
      edit: (noteId, text) => edit(matchId, noteId, text),
    };
  }

  root.RATrackerReplayNotes = {
    MAX_TEXT,
    MAX_NOTES,
    cleanText,
    cleanNote,
    notesOf,
    nextId,
    addNote,
    removeNote,
    editNote,
    markerAt,
    mount,
    listFor,
    add,
    remove,
    edit,
    hooksFor,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerReplayNotes;
}
