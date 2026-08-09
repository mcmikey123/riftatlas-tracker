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

Storage in `chrome.storage.local` is roughly 0.5 KB per match record, ~20 KB for its game log and a few KB for the list of cards you played — so about 25 KB per game. The replay is the big item and lives elsewhere: roughly 1–3 MB compressed per match in the extension's own IndexedDB, and only for as many recent matches as you choose to keep (25 by default). The tracker keeps the frequently-rewritten match list lean by storing logs and card lists under their own keys.

Earlier versions also kept a ~430 KB board-snapshot replay per match under `replay_` keys. Those are gone: the visual replay replaced them, and the first time you open the dashboard after updating, the leftover `replay_` keys are deleted automatically to reclaim the space.

When you want to reclaim more, use **Archive & clear**: it downloads one JSON file containing every match, log and card list, then (after you confirm) wipes them from the extension. Later, **View archive** opens that file read-only — full stats and summaries, with editing disabled and your live data untouched. **Import JSON** does the opposite: merges an archive back into your live data permanently. Archives from before 0.12.0 still import; their old replay data is ignored.

## Deck detection from the cards you played

While you play, the extension records the *codes* of your own cards that become visible — hand, base, battlefields, runes and trash, but not your legend or champion, which are the same across every deck built on that champion. That list is a partial sample of the deck you were on, and two games on the same deck overlap heavily.

**Detect decks from cards played** in the dashboard uses it two ways: if you have named some decks already, it matches unlabelled games against them by card overlap and asks before applying anything; if nothing is named yet, it groups the games into decks and asks you to name each group. Matches it isn't sure about are left alone rather than guessed at.

## Replays

Each match is recorded as a **replay**: the site's own markup and stylesheets, captured as they changed and played back through [rrweb](https://github.com/rrweb-io/rrweb) in a scripting-disabled iframe. It looks exactly like the game did, because it *is* the game's own HTML — not a redrawn board. Open a match in history and click **open full screen** beside **Replay**. Matches without a recording don't show the button.

It costs roughly 1–3 MB compressed per match, kept in the extension's own IndexedDB rather than `chrome.storage.local`. Recording is **always at full fidelity** — a frame per settled game event, start to finish. It is never thinned out to save space, because a replay that quietly skips frames is no longer the match you played, and nothing on screen would tell you which parts were missing.

So disk use is controlled by **how many replays you keep**, not by shrinking any one of them:

- **Keep visual replays for the newest N matches** — **25** by default, anywhere from 1 to 500. Once you have that many, the oldest replay is deleted at the end of each match. Its match record, game log, result and card list are untouched; only the replay goes.
- **Stop a runaway recording at N MB** — a safeguard, not a target. **512 MB** by default against a match that normally costs 1–3 MB, so it should never fire; it exists to stop a pathological recording running away with the disk. Set it from 16 to 4096 MB, or leave the field **blank for no limit at all**. If a recording somehow does hit it, capture stops there and the replay is marked `truncated` — the viewer says which turns it covers — rather than continuing at lower fidelity.

Capture also disables itself for the session if any single frame takes longer than 150 ms, on the principle that the extension never interferes with play. Either way, **the match record, its game log, its result and its card list all carry on to the end of the match** — only the replay stops.

The **Visual replay capture** panel in the dashboard reports what each recording actually cost — size, keyframes, frame timings and how it ended — along with your current total on disk and the mean size per match, which is what to pick a retention number from.

Two things replays are deliberately **not** part of:

- **`Archive & clear` does not include them**, but clearing does delete them: both it and **Clear all** wipe the replay database along with the rest, and deleting a single match deletes that match's recording too. Archive the matches you care about, but expect the replays to be gone afterwards — the archive file cannot bring them back.
- **Export/Import JSON does not carry them.** An export holds matches, logs and card lists; importing one on another machine gives you everything except the replays.

Turn the whole thing off with the **Visual replay** checkbox in the dashboard; everything else the tracker records is unaffected.

## How it works

- A content script watches the game board (`data-testid="game-state"`). When a match enters `in_game`, it records the room code, mode, both players' legends and champions (from card image alt text), and tracks scores and turn count.
- **End detection:** a match ends when someone reaches 8 points, when a victory/defeat/concede message appears, or when the board leaves `in_game`.
- **Deck detection:** the extension polls the deck picker on play.riftatlas.com and remembers the deck you had open — its friendly name and champion — for a couple of hours. When a match starts, that name is used if its champion agrees with the legend on the board; otherwise it falls back to the deck name shown in-game, the room URL, and finally the deck you played last. A name that couldn't be checked at the start is re-checked when the game ends, and dropped if the board turned out to disagree. Hover a deck name in the dashboard to see which source it came from, and type over it to override — hand-typed names are never overwritten, even mid-game.
- **Manual override:** at match end a small toast appears in the bottom-right with the detected result. If it's wrong, click the correct one (Win / Loss / Draw) or "Don't record". You can also edit any match's result later in the dashboard — overridden results are marked `manual`.
- Data lives in `chrome.storage.local`. Use Export JSON/CSV in the dashboard for backups; Import JSON merges records by id.

## Known limitations / notes

- Rift Atlas is actively developed. If a site update changes the board markup, champion capture or auto-detection may stop working until the selectors in `content.js` are updated (the manual toast means no match is silently lost).
- Deck detection knows which deck you had **open in the picker**, not which one the server dealt you. The champion check catches the common mistake (a deck for a different champion), but on its own it can't tell two decks on the same champion apart — if you browse "Diana Control" and then launch "Diana Aggro", the match is labelled with the one you looked at last. **Detect decks from cards played** is what separates those two: it compares the cards each game actually showed, which differ between variants even when the champion doesn't. Hover the name to see how it was arrived at, and type over it when it's wrong.
- Opponent score reading uses a styling heuristic (their track has no `aria-pressed` marker); if it misreads, the end-of-match toast is the safety net.
- Matches abandoned mid-game (tab closed) are saved with result `unknown` so you can fill them in from the dashboard.
- Replays live outside the export path: they aren't in Export JSON, Import JSON or `Archive & clear`, and only the newest 25 matches keep one. Treat them as a recent-history tool — the match record, its game log and its card list are what archive.