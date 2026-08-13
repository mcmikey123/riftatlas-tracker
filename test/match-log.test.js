"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeLog, logSig, stripRepeatedTime } = require("../capture/match-log.js");

/* The merge runs on every scrape of a live game - several times a second - and
 * a mistake in it is invisible until someone reads the match back weeks later:
 * a log that doubles every line, or one that silently stops growing. */

const line = (t, text, actor) => ({ t, actor: actor || "system", text });

const A = line("16:11", "Conquered Howling Abyss and scored 1.");
const B = line("16:12", "monke drew a card.", "opponent");
const C = line("16:13", "You drew a card.", "self");
const D = line("16:14", "Turn 4 begins.");

const MAX = 500;

test("1. re-scanning an unchanged panel changes nothing", () => {
  /* The site re-renders the whole list, so every scrape hands back new nodes for
   * lines already stored. Counting occurrences is what tells them apart; if this
   * ever fails, a live match's log grows by the length of the panel per tick. */
  const scrape = [A, B, C];
  let log = mergeLog([], scrape, MAX);
  assert.deepEqual(log, [A, B, C]);
  for (let n = 0; n < 5; n++) log = mergeLog(log, scrape, MAX);
  assert.deepEqual(log, [A, B, C]);
});

test("2. a genuinely repeated line appends only the new occurrence", () => {
  // "You drew a card." twice in one turn is two events, not one - which is why
  // the merge counts occurrences rather than keeping a set of seen lines.
  let log = mergeLog([], [A, C], MAX);
  log = mergeLog(log, [A, C, C], MAX);
  assert.deepEqual(log, [A, C, C]);
  log = mergeLog(log, [A, C, C], MAX);
  assert.deepEqual(log, [A, C, C], "a third scrape of the same two must add nothing");
});

test("3. new lines are appended in the order the panel shows them", () => {
  // The caller reverses the panel (it renders newest-first) before merging, so
  // what arrives here is oldest-first and the log only grows at the end.
  let log = mergeLog([], [A, B], MAX);
  log = mergeLog(log, [A, B, C, D], MAX);
  assert.deepEqual(log, [A, B, C, D]);
});

test("4. overflow drops the oldest lines, not the newest", () => {
  // A long game's opening turns are the cheapest thing to lose; the end of the
  // match is what a player reads a log back for.
  const log = mergeLog([A, B], [A, B, C, D], 3);
  assert.deepEqual(log, [B, C, D]);
});

test("5. the merge does not touch the array it was given", () => {
  /* The stored log is handed straight to the log_<id> writer, so a merge that
   * mutated it would be half-applied into storage if the merge later threw. */
  const existing = [A, B];
  const merged = mergeLog(existing, [A, B, C], MAX);
  assert.deepEqual(existing, [A, B]);
  assert.notEqual(merged, existing);
  // A record from before logs existed has no array at all.
  assert.deepEqual(mergeLog(undefined, [A], MAX), [A]);
  assert.deepEqual(mergeLog(null, [], MAX), []);
});

/* KNOWN, PINNED AS-IS - at the cap, evicted lines come back at the wrong end.
 *
 * `stored` is counted once, from the log as it was before the merge. Lines the
 * merge itself evicts from the front are still on screen, so the NEXT scrape
 * finds them with a stored count of 0 and appends them again - at the end, out
 * of chronological order, evicting yet another line from the front to make
 * room. Once a match passes MAX_LOG lines while the panel still shows the
 * evicted ones, the tail of the log churns on every scrape.
 *
 * Not fixed here: the fix is a decision about what the cap means (drop the
 * scrape's own head, or key eviction on what the panel still shows), and this
 * refactor changes no behaviour. */
test("6. at the cap, a line evicted while still on screen is re-appended out of order", () => {
  const scrape = [A, B, C, D];
  const first = mergeLog([A, B, C], scrape, 3);
  assert.deepEqual(first, [B, C, D], "D pushed A out");

  const second = mergeLog(first, scrape, 3);
  assert.deepEqual(second, [C, D, A], "A came back, after D, and took B with it");

  const third = mergeLog(second, scrape, 3);
  assert.deepEqual(third, [D, A, B], "B comes back next, and D loses its place");

  // It never settles: the stored log rotates through the panel forever, one
  // line per scrape, so the log a player reads back depends on which tick the
  // match happened to end on.
  assert.deepEqual(mergeLog(third, scrape, 3), [A, B, C]);
});

test("7. a line's identity is its time, its actor and its text together", () => {
  // Two players can say the same words in the same minute; the actor bar is
  // what separates them, so it is part of the identity rather than decoration.
  const mine = line("16:12", "gg", "self");
  const theirs = line("16:12", "gg", "opponent");
  assert.notEqual(logSig(mine), logSig(theirs));
  assert.deepEqual(mergeLog([mine], [mine, theirs], MAX), [mine, theirs]);
});

test("8. only the row's own timestamp is stripped, and only where it is noise", () => {
  /* A chat row's raw text carries its time up to three times
   * ("16:34You at 16:34: nice?16:34"); the dashboard draws `t` itself. */
  assert.equal(stripRepeatedTime("16:34You at 16:34: nice?16:34", "16:34"), "You: nice?");
  assert.equal(stripRepeatedTime("16:11Conquered X and scored 1.", "16:11"), "Conquered X and scored 1.");
  // A time that genuinely differs is part of what was said.
  assert.equal(stripRepeatedTime("16:34see you at 17:00", "16:34"), "see you at 17:00");
  assert.equal(stripRepeatedTime("nothing to strip", "16:34"), "nothing to strip");
});

/* KNOWN, PINNED AS-IS - `t` is interpolated into three RegExps unescaped.
 *
 * Nothing in the game log can reach this: content.js only calls it with a span
 * whose whole text matched /^\d{1,2}:\d{2}$/, and digits and a colon are inert
 * in a pattern. That guard is the only thing standing between a scraped string
 * and a compiled regex, which is why this test exists - it fails the day
 * someone loosens the shape check upstream. */
test("9. a timestamp containing regex metacharacters is not escaped, and throws", () => {
  assert.throws(() => stripRepeatedTime("(1:2) hello", "1:2)"), SyntaxError);
  // Silently wrong rather than loud, when the metacharacters happen to compile:
  // "1.2" matches "142", so text the caller never meant is stripped.
  assert.equal(stripRepeatedTime("142 points", "1.2"), "points");
});
