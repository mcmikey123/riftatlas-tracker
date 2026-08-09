# Rift Atlas Stats Tracker

A Chrome extension that records your matches on play.riftatlas.com — win/loss rate, match history, and win rate vs specific opponent champions. Everything is stored locally in your browser; nothing is uploaded anywhere. The extension is purely passive: it reads the board, it never plays for you.

## ⚠️ Updating without losing your history

Chrome ties an extension's stored data to the extension's identity, and for an unpacked extension that identity comes from **the folder path it was loaded from**. So:

- **DO:** copy the new files *over* the existing folder, then press the reload arrow (↻) on the extension at `chrome://extensions`, then refresh the game tab.
- **DON'T:** unzip to a new folder and "Load unpacked" it — Chrome treats that as a different extension with empty storage.
- **DON'T:** press Remove and re-add — removing an extension deletes its data.

Turn on **Daily auto-backup to Downloads** in the dashboard (or press Export JSON now and then). Backups land in `Downloads/riftatlas-backups/` and can be restored with Import JSON into any install, so a mistake stops being fatal.

## Install (load unpacked)

1. Download and unzip this folder somewhere permanent (Chrome loads it from disk).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `riftatlas-tracker` folder.
5. Open play.riftatlas.com and play — matches record automatically.

Open the dashboard by clicking the extension's icon in the toolbar (pin it via the puzzle-piece menu for one-click access).

## What it records

Per match: your and your opponent's legend + champion, room code, mode, player names, running score, turn count, **match duration**, the **full game log** (with each line attributed to you, your opponent, or the system), and your own **notes**. Click any row in match history to open the game summary, notes box and raw log.

The **game summary** reads the log and reports a playstyle verdict — Aggressive, Balanced, Passive, Reactive or "No read" — from how many units each side committed to battlefields, battlefields conquered, cards lost to trash, showdown actions and focus passes. It also tells you how many log lines it understood, so you can judge how much to trust it.

## Archiving old games

Storage is roughly 0.5 KB per match record, ~20 KB for its game log and ~430 KB for its replay, so about 450 KB per game all-in (visual replays are separate — see below). Disk isn't the practical limit (1,000 games ≈ 440 MB) — the tracker keeps the frequently-rewritten match list lean by storing logs and replays under their own keys.

When you want to reclaim space, use **Archive & clear**: it downloads one JSON file containing every match, log and replay, then (after you confirm) wipes them from the extension. Later, **View archive** opens that file read-only — full stats, summaries and replays, with editing disabled and your live data untouched. **Import JSON** does the opposite: merges an archive back into your live data permanently.

## Replays

Every game is also recorded as a **step-through replay**. The extension takes a board snapshot each time Rift Atlas bumps its authoritative action counter, so you get roughly one frame per real game event: both battlefields and what each side committed there, legends, champions, bases, runes, hand/deck/trash counts and the score.

Open a match in history and click **Replay** to scrub through it with a slider or play it back. Snapshots store card *codes*, not images — the viewer rebuilds art URLs from the same CDN the site uses, and falls back to named tiles if art can't be fetched.

A full game is a few hundred KB, kept in a separate `replay_` storage key so the match list stays fast. Deleting a match deletes its replay.

## Visual replay

Alongside the step-through replay, each match is recorded as a **visual replay**: the site's own markup and stylesheets, captured as they changed and played back through [rrweb](https://github.com/rrweb-io/rrweb) in a scripting-disabled iframe. It looks exactly like the game did, because it *is* the game's own HTML — not a redrawn board. Open a match in history and click **visual** beside **Replay**. Matches without a visual track don't show the button.

It costs roughly 1–3 MB compressed per match, kept in the extension's own IndexedDB rather than `chrome.storage.local`. Each match gets a budget — **8 MB compressed** by default, adjustable from 1 to 64 MB in the dashboard — and degrades in steps as it fills:

- **up to 80%** — a frame per settled game event, as normal.
- **80–100%** — frames are coalesced to at most one every 3 seconds.
- **100%** — visual capture stops for the rest of that match and the replay is marked `truncated`. **The step-through replay continues to the end of the match regardless**, so nothing is lost that the tracker recorded before this feature existed.

Capture also disables itself for the session if any single frame takes longer than 150 ms, on the principle that the extension never interferes with play. The **Visual replay capture** panel in the dashboard reports what each recording actually cost — size, keyframes, frame timings and which of the states above it ended in.

Only the **newest 25 matches** keep a visual track; older ones are dropped automatically at the end of each match. Their match records, logs and step-through replays are untouched.

Two things visual replays are deliberately **not** part of:

- **`Archive & clear` does not include them**, but clearing does delete them: both it and **Clear all** wipe the visual database along with the rest, and deleting a single match deletes that match's visual recording too. Archive the matches you care about, but expect the visual tracks to be gone afterwards — the archive file cannot bring them back.
- **Export/Import JSON does not carry them.** An export holds matches, logs and step-through replays; importing one on another machine gives you everything except the visual recordings.

Turn the whole thing off with the **Visual replay** checkbox in the dashboard; the tracker and the step-through replay are unaffected.

## How it works

- A content script watches the game board (`data-testid="game-state"`). When a match enters `in_game`, it records the room code, mode, both players' legends and champions (from card image alt text), and tracks scores and turn count.
- **End detection:** a match ends when someone reaches 8 points, when a victory/defeat/concede message appears, or when the board leaves `in_game`.
- **Deck detection:** the extension polls the deck picker on play.riftatlas.com and remembers the deck you had open — its friendly name and champion — for a couple of hours. When a match starts, that name is used if its champion agrees with the legend on the board; otherwise it falls back to the deck name shown in-game, the room URL, and finally the deck you played last. A name that couldn't be checked at the start is re-checked when the game ends, and dropped if the board turned out to disagree. Hover a deck name in the dashboard to see which source it came from, and type over it to override — hand-typed names are never overwritten, even mid-game.
- **Manual override:** at match end a small toast appears in the bottom-right with the detected result. If it's wrong, click the correct one (Win / Loss / Draw) or "Don't record". You can also edit any match's result later in the dashboard — overridden results are marked `manual`.
- Data lives in `chrome.storage.local`. Use Export JSON/CSV in the dashboard for backups; Import JSON merges records by id.

## Known limitations / notes

- Rift Atlas is actively developed. If a site update changes the board markup, champion capture or auto-detection may stop working until the selectors in `content.js` are updated (the manual toast means no match is silently lost).
- Deck detection knows which deck you had **open in the picker**, not which one the server dealt you. The champion check catches the common mistake (a deck for a different champion), but it can't tell two decks on the same champion apart — if you browse "Diana Control" and then launch "Diana Aggro", the match is labelled with the one you looked at last. Hover the name to see how it was arrived at, and type over it when it's wrong.
- Opponent score reading uses a styling heuristic (their track has no `aria-pressed` marker); if it misreads, the end-of-match toast is the safety net.
- Matches abandoned mid-game (tab closed) are saved with result `unknown` so you can fill them in from the dashboard.
- Visual replays live outside the export path: they aren't in Export JSON, Import JSON or `Archive & clear`, and only the newest 25 matches keep one. Treat them as a recent-history tool — the step-through replay is the one that archives.