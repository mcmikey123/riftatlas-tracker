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

Storage is roughly 0.5 KB per match record, ~20 KB for its game log and ~430 KB for its replay, so about 450 KB per game all-in. Disk isn't the practical limit (1,000 games ≈ 440 MB) — the tracker keeps the frequently-rewritten match list lean by storing logs and replays under their own keys.

When you want to reclaim space, use **Archive & clear**: it downloads one JSON file containing every match, log and replay, then (after you confirm) wipes them from the extension. Later, **View archive** opens that file read-only — full stats, summaries and replays, with editing disabled and your live data untouched. **Import JSON** does the opposite: merges an archive back into your live data permanently.

## Replays

Every game is also recorded as a **step-through replay**. The extension takes a board snapshot each time Rift Atlas bumps its authoritative action counter, so you get roughly one frame per real game event: both battlefields and what each side committed there, legends, champions, bases, runes, hand/deck/trash counts and the score.

Open a match in history and click **Replay** to scrub through it with a slider or play it back. Snapshots store card *codes*, not images — the viewer rebuilds art URLs from the same CDN the site uses, and falls back to named tiles if art can't be fetched.

A full game is a few hundred KB, kept in a separate `replay_` storage key so the match list stays fast. Deleting a match deletes its replay.

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