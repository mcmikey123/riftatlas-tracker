# Rift Atlas Stats Tracker

A Chrome extension that records your matches on play.riftatlas.com — win/loss rate, match history, and win rate vs specific opponent champions. Everything is stored locally in your browser; nothing is uploaded anywhere. The extension is purely passive: it reads the board, it never plays for you.

## ⚠️ Updating without losing your history

Chrome ties an extension's stored data to the extension's identity, and for an unpacked extension that identity comes from **the folder path it was loaded from**. So:

- **DO:** copy the new files *over* the existing folder, then press the reload arrow (↻) on the extension at `chrome://extensions`, then refresh the game tab.
- **DON'T:** unzip to a new folder and "Load unpacked" it — Chrome treats that as a different extension with empty storage.
- **DON'T:** press Remove and re-add — removing an extension deletes its data.

Turn on **Daily auto-backup to Downloads** in the dashboard's **Settings** view (or press Export JSON now and then). Backups land in `Downloads/riftatlas-backups/` and can be restored with Import JSON into any install, so a mistake stops being fatal.

## Install (load unpacked)

1. Download and unzip this folder somewhere permanent (Chrome loads it from disk).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `riftatlas-tracker` folder.
5. Open play.riftatlas.com and play — matches record automatically.

**Clicking the extension's icon no longer opens the dashboard.** It opens a small popup instead, showing whether the next match will be recorded, today's record, your streak and your last three results. The dashboard is one click further on, behind the popup's **Open dashboard** button. Pin the icon via the puzzle-piece menu to keep the popup within reach.

## The dashboard

The dashboard is six views behind a left nav, not one long scrolling page. The header, the filter row and the banners are shared by all of them, and switching views reloads nothing.

- **Overview** — the stat tiles and the three aggregate tables (win rate vs opponent champion, by your deck, by your champion), plus **Detect decks from cards played**.
- **Matches** — your full history. Every column sorts, a search box covers opponent, room code, either champion and deck name, a date range narrows the set, and rows come 25 to a page. The old 13 columns are now 12 cells carrying the same 13 fields — date and time stack, your champion, opponent and their champion become one Matchup cell, and mode and room stack — with **Delete** moved into each row's ⋯ menu beside Share replay and Copy match id. Nothing was dropped.
- **Series** — best-of series, described below.
- **Replays** — the **Visual replay capture** panel.
- **Shared links** — the replays you have shared from this browser.
- **Settings** — every setting, with its explanation beside it rather than hidden in a tooltip.

While you are viewing an archive, Replays and Shared links are taken out of the nav rather than greyed out: an archive file carries no recordings, and its matches have no relationship to what this browser shared.

The extension no longer uses the browser's own confirm, prompt and alert boxes. Decisions are in-page dialogs and one-line acknowledgements are toasts.

## What it records

Per match: your and your opponent's legend + champion, room code, mode, player names, running score, turn count, **match duration**, the **full game log** (with each line attributed to you, your opponent, or the system), and your own **notes**. Open a row in **Matches** to see the game summary, notes box and raw log.

The **game summary** reads the log and reports a playstyle verdict — Aggressive, Balanced, Passive, Reactive or "No read" — from how many units each side committed to battlefields, battlefields conquered, cards lost to trash, showdown actions and focus passes. It also tells you how many log lines it understood, so you can judge how much to trust it.

## Best-of-3 series

Matches against the same opponent, in the same mode, played back to back are grouped into a best-of series for you. "Back to back" means the gap from one match ending to the next starting falls inside a window — **45 minutes** by default, settable from 5 to 240 in Settings, along with whether a series still in progress is assumed to be a Bo3 or a Bo5.

The **Series** view shows one row per series, expandable into its games. Its tiles are the reason it exists: series win rate beside game win rate, how often you recover after losing game one, and how often you reach a decider. Your matches already held all of that; the old dashboard had nowhere to show it.

**Grouping done for you is worked out fresh each time the page draws it, and is never written to your match records.** Two things follow from that:

- Change the window and your whole history regroups at once. There is nothing to re-scan, because every draw is a scan.
- Only groupings you make by hand are stored. Select rows in **Matches** and press **Group as a Bo3 series**, and that grouping is marked as yours and is never revised by detection afterwards — the same rule a deck name you type follows.

Series survive a backup either way. Export JSON carries the groupings you made by hand, because those live on the match records. The automatic ones aren't in the file and don't need to be: they are worked out again from the matches themselves wherever the data is opened.

Pairs that fall just outside the window are suggested at the top of the Series view rather than grouped for you, since that is exactly where guessing would be wrong often enough to matter. Dismiss one and it isn't offered again.

## Archiving old games

Storage in `chrome.storage.local` is roughly 0.5 KB per match record, ~20 KB for its game log and a few KB for the list of cards you played — so about 25 KB per game. The replay is the big item and lives elsewhere: roughly 1–3 MB compressed per match in the extension's own IndexedDB, and only for as many recent matches as you choose to keep (25 by default). The tracker keeps the frequently-rewritten match list lean by storing logs and card lists under their own keys.

Earlier versions also kept a ~430 KB board-snapshot replay per match under `replay_` keys. Those are gone: the visual replay replaced them, and the first time you open the dashboard after updating, the leftover `replay_` keys are deleted automatically to reclaim the space.

When you want to reclaim more, use **Archive & clear**: it downloads one JSON file containing every match, log and card list, then (after you confirm) wipes them from the extension. It clears only what actually went into the file, so a match that finished while the confirmation was open is kept rather than destroyed. Later, **View archive** opens that file read-only — full stats and summaries, with editing disabled and your live data untouched. **Import JSON** does the opposite: merges an archive back into your live data permanently. Archives from before 0.12.0 still import; their old replay data is ignored.

## Deck detection from the cards you played

While you play, the extension records the *codes* of your own cards that become visible — hand, base, battlefields, runes and trash, but not your legend or champion, which are the same across every deck built on that champion. That list is a partial sample of the deck you were on, and two games on the same deck overlap heavily.

**Detect decks from cards played**, on **Overview**, uses it two ways: if you have named some decks already, it matches unlabelled games against them by card overlap and asks before applying anything; if nothing is named yet, it groups the games into decks and asks you to name each group. Matches it isn't sure about are left alone rather than guessed at.

## Replays

Each match is recorded as a **replay**: the site's own markup and stylesheets, captured as they changed and played back through [rrweb](https://github.com/rrweb-io/rrweb) in a scripting-disabled iframe. It looks exactly like the game did, because it *is* the game's own HTML — not a redrawn board. Open a row in **Matches** and click **Open full screen** beside **Replay**. Matches without a recording don't show the button.

It costs roughly 1–3 MB compressed per match, kept in the extension's own IndexedDB rather than `chrome.storage.local`. Recording is **always at full fidelity** — a frame per settled game event, start to finish. It is never thinned out to save space, because a replay that quietly skips frames is no longer the match you played, and nothing on screen would tell you which parts were missing.

So disk use is controlled by **how many replays you keep**, not by shrinking any one of them:

- **Keep visual replays for the newest N matches** — **25** by default, anywhere from 1 to 500. Once you have that many, the oldest replay is deleted at the end of each match. Its match record, game log, result and card list are untouched; only the replay goes.
- **Stop a runaway recording at N MB** — a safeguard, not a target. **512 MB** by default against a match that normally costs 1–3 MB, so it should never fire; it exists to stop a pathological recording running away with the disk. Set it from 16 to 4096 MB, or leave the field **blank for no limit at all**. If a recording somehow does hit it, capture stops there and the replay is marked `truncated` — the viewer says which turns it covers — rather than continuing at lower fidelity.

Capture also disables itself for the session if any single frame takes longer than 150 ms, on the principle that the extension never interferes with play. Either way, **the match record, its game log, its result and its card list all carry on to the end of the match** — only the replay stops.

The **Visual replay capture** panel, in the **Replays** view, reports what each recording actually cost — size, keyframes, frame timings and how it ended — along with your current total on disk and the mean size per match, which is what to pick a retention number from.

Two things replays are deliberately **not** part of:

- **`Archive & clear` does not include them**, but clearing does delete them: both it and **Clear all** wipe the replay database along with the rest, and deleting a single match deletes that match's recording too. Archive the matches you care about, but expect the replays to be gone afterwards — the archive file cannot bring them back.
- **Export/Import JSON does not carry them.** An export holds matches, logs and card lists; importing one on another machine gives you everything except the replays.

Turn the whole thing off with the **Visual replay** checkbox in Settings; everything else the tracker records is unaffected.

## How it works

- A content script watches the game board (`data-testid="game-state"`). When a match enters `in_game`, it records the room code, mode, both players' legends and champions (from card image alt text), and tracks scores and turn count.
- **End detection:** a match ends when someone reaches 8 points, when a victory/defeat/concede message appears, or when the board leaves `in_game`.
- **Deck detection:** the extension polls the deck picker on play.riftatlas.com and remembers the deck you had open — its friendly name and champion — for a couple of hours. When a match starts, that name is used if its champion agrees with the legend on the board; otherwise it falls back to the deck name shown in-game, the room URL, and finally the deck you played last. A name that couldn't be checked at the start is re-checked when the game ends, and dropped if the board turned out to disagree. Hover a deck name in **Matches** to see which source it came from, and pick or type over it to override — hand-typed names are never overwritten, even mid-game.
- **Manual override:** at match end a small toast appears in the bottom-right with the detected result. If it's wrong, click the correct one (Win / Loss / Draw) or "Don't record". You can also edit any match's result later from its row in **Matches** — overridden results are marked `manual`.
- Data lives in `chrome.storage.local`. Use Export JSON/CSV in the dashboard header, or in Settings, for backups; Import JSON merges records by id.
- **Series detection:** a series is not a stored thing — it is the set of matches sharing a series id, worked out at the moment the page draws them. Only groupings you make by hand are written, and detection skips those from then on.

## Known limitations / notes

- Rift Atlas is actively developed. If a site update changes the board markup, champion capture or auto-detection may stop working until the selectors in `content.js` are updated (the manual toast means no match is silently lost).
- Deck detection knows which deck you had **open in the picker**, not which one the server dealt you. The champion check catches the common mistake (a deck for a different champion), but on its own it can't tell two decks on the same champion apart — if you browse "Diana Control" and then launch "Diana Aggro", the match is labelled with the one you looked at last. **Detect decks from cards played** on Overview is what separates those two: it compares the cards each game actually showed, which differ between variants even when the champion doesn't. Hover the name to see how it was arrived at, and type over it when it's wrong.
- Opponent score reading uses a styling heuristic (their track has no `aria-pressed` marker); if it misreads, the end-of-match toast is the safety net.
- Matches abandoned mid-game (tab closed) are saved with result `unknown` so you can fill them in from **Matches**. A match that is still in progress can have its result edited, but the change is reverted within a few seconds while the game tab is still open — wait until the match has ended.
- Replays live outside the export path: they aren't in Export JSON, Import JSON or `Archive & clear`, and only the newest 25 matches keep one. Treat them as a recent-history tool — the match record, its game log and its card list are what archive.