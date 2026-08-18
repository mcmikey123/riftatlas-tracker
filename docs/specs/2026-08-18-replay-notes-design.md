# Timestamped Replay Notes — Design

Date: 2026-08-18
Status: accepted

## Goal

Let a note be pinned to a moment of a replay while it is being watched, and read the whole set
back where a match is read.

Every match already has a free-text notes box in its expanded row. It is written *after* the
match, from memory, about the whole game — so it says "misplayed the mid game" and nothing can
say which turn that was. Review is the opposite shape: you watch, something goes wrong, you want
to say so *there*. This is item 7 of the tier-2 list in
`docs/research/2026-08-14-riftlite-feature-comparison.md` ("replay flags"), which is where the
competitor is ahead of us.

Two surfaces, one set of notes:

- **In the replay** — a drawer beside the board, open on demand, listing every note in playback
  order with a composer under it, plus markers on the scrubber.
- **On the match** — the same notes summarised in the expanded row in **Matches**, each timestamp
  opening the replay at the moment it names.

## Where a note lives

On the **match record**, as `timedNotes: [{ id, atMs, text }]`, beside the free-text `notes`
field that has always been there.

That is the call the research doc made, and it buys three things for nothing: **Export JSON**
carries them, **Import JSON** merges them back, and an **archive** file opens with them intact.
A `notes_<id>` key of its own — the arrangement game logs and card lists use — would need wiring
in the bundle writer, the bundle reader and the archive path, and would still be missing from
every export written before that wiring existed.

What it costs is bytes on the array that is rewritten every few seconds while a match is live,
which is the reason logs were split out into their own keys in the first place. So the shape is
kept small deliberately:

| Cap | Value | Why |
|---|---|---|
| `MAX_TEXT` | 500 characters | A note is a reminder, not a report. |
| `MAX_NOTES` | 200 per match | Far past any real review; stops a stuck key costing a megabyte. |
| empty list | field deleted | An empty array per match is bytes that say what their absence says. |

Both caps are enforced **on the way in and on the way back out**: a record can arrive from an
imported file this build never wrote.

A note is `{ id, atMs, text }` and nothing else. There is no "created at" — the timestamp that
matters is the one in the replay, and a second one would be a field to keep honest for a line
nobody reads.

### What a note is not

- **Not part of a share.** A share is a replay handed to someone else; a note is what you thought
  while watching it. The payload, the frame, the Worker and the standalone viewer are untouched by
  this feature. (A future "share with my notes" is a payload change and a viewer change, and would
  need its own pass at the privacy question: notes name opponents.)
- **Not tied to the recording's lifetime.** Retention deletes the oldest replays; the notes stay on
  the match. The summary then shows them as plain text rather than as buttons that would open
  nothing.
- **Not a CSV column.** A list does not fit a cell. The JSON export is where they travel.

## The files

| File | Owns |
|---|---|
| `dashboard/replay-notes.js` *(new)* | What a note is, which id the next one gets, where a marker sits — and the one write onto the match record. |
| `dashboard/replay-html.js` | The drawer: markup, the pin, the composer, the markers, `n`, Escape. |
| `dashboard/view-matches.js` | The summary in the expanded row, and the row's note dot. |
| `dashboard/view-replays.js` | Hands the modal a notes handler, and a moment when a click named one. |
| `dashboard/legacy.js` | Mounts the notes store over the match array and the one writer. |

The split is the one every drained view already has: the rules live in the module, the array and
the writer stay in `legacy.js`. `replay-notes.js` is a classic script published as
`window.RATrackerReplayNotes`, loaded before `replay-html.js` (which reads it as it evaluates),
`view-replays.js` and `legacy.js`.

`replay-html.js` takes the notes handler as `options.notes`, exactly as it already takes
`options.shareMoment`: reading and writing a match's notes needs the match array and the
dashboard's writer, neither of which the chrome has or should have. A modal opened without a
handler — which is what an archive is — has **no drawer and no toggle**, rather than a drawer that
cannot save.

## The pin

**The moment is taken when the writing starts, not when Save is pressed.**

A note is about the board that prompted it. By the time a sentence has been typed the replay is
somewhere else entirely, and a note saved against *that* position points at the consequence rather
than the cause. So focusing the composer does two things at once: it **pauses playback** and it
**latches the position**. The label above the box follows the clock until that happens and then
stops dead, which is the whole contract of the feature and is the one line in the drawer set in
the accent colour.

Clearing the draft releases the pin and the label follows the clock again. Escape does the same:
a half-written note owns Escape before the modal does, and a second press closes the window as it
always did — the same first-refusal rule fullscreen already has.

## Reading them back

The summary in the expanded row draws each timestamp as a button carrying **`data-visual` with a
`data-at`** — the same attribute the "Open full screen" button uses, so there is still exactly one
path from a click to a replay. `view-replays.js` reads the extra attribute and passes it on as
`startAtMs`, which the playback core already understands from share links that name a moment: it
opens there and suppresses autoplay, because someone said "look at this". The drawer opens with
it, so the note arrives beside the list it came from.

Markers on the scrubber are an overlay, inset by half a thumb at each end, taking **no pointer
events at all** — a marker that swallowed a press would break the drag it sits on top of. Seeking
to a note is the drawer's job.

## Deleting

One note is one line of text the same panel can retype in seconds, so there is no dialog — unlike
the match, the log and the recording next to it, which nothing can bring back. The ✕ is explicit
and per-note in both places.

## What is tested

- `test/replay-notes.test.js` — the model over what an imported file can actually contain (no
  text, no position, duplicate ids, past the cap); the write, including the archive's veto and the
  deletion of an empty field; and **the drawer driven for real** — the shipped playback core, the
  shipped transport row and the shipped chrome against a fake rrweb and the parsed-markup page from
  `test/fake-page.js`. The pin is wiring, not arithmetic, and wiring is only checked by running it.
- `test/view-matches.test.js` — the row's dot, the summary, the recording-is-gone case and the
  archive's read-only rendering.
