# RiftLite feature comparison — what to build next

**Date:** 2026-08-14
**Status:** Research. Nothing here is committed work; each "recommended" item still needs its own
design pass before implementation.

RiftLite (https://www.riftlite.com/) is a free desktop companion app for Riftbound that tracks
matches on both TCG-Arena and RiftAtlas. It is the closest competitor to this extension and its
feature list is a useful mirror: some of it we already do better, some of it we should copy, and
some of it we should refuse on principle. This document goes feature by feature and ends with a
ranked list of what to build.

## The two products in one paragraph each

**RiftLite** is a desktop app (Windows, Mac beta) that sits in the background and logs every match
played on TCGA or RiftAtlas — legends, deck, points, result. On top of that it offers animated
Atlas replays and full video review (playback up to 6×, flags, drawings, audio notes, MP4 and
vertical-clip export), a personal matchup matrix (recent form, going-first splits, battlefield
performance, drill-down to the matches behind every number), a live OBS overlay, deck prep
(decklists with version snapshots, mulligan plans, battlefield priorities, matchup notes),
community-wide matchup and deck data fed by its users' games, and private testing teams. Free, no
account required — but games feed community stats by default.

**This extension** is a Chrome extension scoped to play.riftatlas.com. Everything stays in the
browser; nothing is uploaded unless the user explicitly shares one encrypted replay. It records a
richer per-match record than RiftLite exposes (full attributed game log, card codes seen, duration,
room code, format), reconstructs Bo3 series from the lobby format, detects decks from cards played,
renders pixel-exact rrweb replays of the site's own DOM, and shares them end-to-end encrypted with
a 7-day TTL. The dashboard has six views, aggregate tables, filters, CSV/JSON export, archives and
auto-backup.

## Feature-by-feature

### Match tracking

| | RiftLite | Us |
|---|---|---|
| RiftAtlas | yes | yes |
| TCG-Arena | yes | **no** |
| Fields | legends, deck, points, result | legends, champions, scores, turns, duration, room, mode, names, format, full log, card codes, notes |

Our per-match record is deeper; their coverage is wider. TCGA support is their single biggest
structural advantage: a player who splits time across both sites gets half a history from us and a
whole one from them. Supporting TCGA means a second host permission, a second capture adapter, and
a second set of DOM assumptions to maintain — a large, ongoing commitment, not a feature. Worth a
scoping investigation (how similar is TCGA's DOM?) before any promise.

### Replays and review

Their replays are "animated Atlas replays" — a redrawn board. Ours are the site's own markup
replayed through rrweb: strictly higher fidelity. This is our headline advantage and worth stating
in the README in exactly those terms.

Their *review tooling* around replays, however, is well ahead:

- **Playback speed up to 6×.** We have none — and `speedOption: [1]` already sits in the viewer as
  known-dead config (listed in the outstanding issues of the sharing implementation plan). This is
  the cheapest possible catch-up: wire real speed steps (0.5/1/2/4/6×) into the existing controls.
- **Flags** (bookmarks on the timeline). We already have chapter chips per turn and "copy link to
  this moment"; per-match flags are a natural extension — timestamps + short text stored on the
  match record, rendered as markers on the scrubber. They'd survive export/import for free since
  they'd live on the match record, and shared links could carry them in the payload.
- **Drawings and audio notes.** Heavy, storage-hungry, and awkward in an MV3 page. Skip.
- **MP4 / vertical-clip export.** Genuinely hard in an extension (re-render into a canvas, encode
  WebM, no ffmpeg). Our answer to "send someone this moment" is the encrypted share link, which is
  better where the recipient has a browser and worse where they have TikTok. Defer; revisit only if
  users ask for clips specifically.

### Personal stats

This is where they beat our current dashboard on presentation, and where the data we already store
is ahead of what we show:

- **Matchup matrix.** A my-champion × opponent-champion grid with win rates and drill-down. We have
  three flat aggregate tables; every number a matrix needs is already on the match records. High
  value, pure dashboard work, no capture changes.
- **Recent form.** Last-10 / last-20 record, trend direction. Trivial to compute; the popup already
  shows a streak, the dashboard shows nothing time-local.
- **Trends over time** (win rate by week). Explicitly deferred in the dashboard-redesign spec as
  "new product rather than repair" — a defensible call then, but the competitor now ships it, and
  the Series view established the pattern of a view earning its place through tiles the data
  already supports.
- **Going-first splits.** We don't capture who went first. The game log likely knows (first turn
  attribution); if not, the lobby or turn-1 DOM does. One new field on the match record
  (`wentFirst: true|false|null`, null for history), then every stat splits by it. Capture-side
  work, so needs the usual care, but small.
- **Battlefield performance.** Our log analysis already counts battlefields committed and
  conquered per side for the playstyle verdict. Aggregating per-battlefield win rates (which
  battlefields you win on, which you bleed on) is a new pure-analysis pass over logs we already
  store. Verify first that battlefield *names* are recoverable from log lines, not just counts.

### Deck prep

They store decklists with version snapshots, mulligan plans, battlefield priorities and
matchup-specific notes. We detect decks from play and attach free-text notes per match. The gap
worth closing is not deck *building* (the sites themselves do that) but **notes that surface when
they're useful**:

- **Per-matchup notes.** Notes keyed on (my deck, opponent champion) rather than on one match.
- **Pre-match scouting in the popup.** The content script already reads the lobby. When the
  opponent's champion is visible before game one, the popup can show your record and your matchup
  note against that champion. RiftLite calls this "matchup prep"; for us it is a join over data we
  already hold, surfaced at the moment it matters. This is the feature most likely to make someone
  open the popup daily.

### Streaming (OBS overlay)

They render a live overlay for OBS. We cannot serve a browser-source URL from an extension, but an
extension page with a transparent background showing today's record/streak — window-captured by
OBS — gets 90% of it. Niche audience; only worth building if streamers actually ask.

### Community data, accounts, teams

RiftLite's community matchup matrix and deck stats are fed by its users' games, and its teams
feature implies identity and sync. **We should not follow.** "Everything is stored locally; nothing
is uploaded anywhere" is the first paragraph of our README and the reason a privacy-conscious
player picks us; ADR 0001 deliberately pins the only server component we have to the Workers Free
plan precisely so it can never quietly grow into infrastructure. Community stats would invert the
product's identity for a fight we'd lose anyway — riftDecks, Riftools and RiftLite already split
that market three ways. The local-first position is the differentiator; keep it clean.

If sharing-between-friends pressure grows, the already-specced-but-unbuilt **share a whole series**
Worker feature is the privacy-compatible move, not accounts.

## What to do — ranked

**Tier 1 — dashboard-only, data already captured, high visibility:**
1. Replay playback speed (0.5–6×) — also retires the dead `speedOption` config.
2. Matchup matrix view (champion × champion, filters apply, cells drill into Matches).
3. Recent-form tile (last 10/20) on Overview.
4. Trends view or Overview chart: win rate by week. Un-defer it.

**Tier 2 — small capture or analysis additions:**
5. Going-first capture + splits across all stats.
6. Battlefield performance aggregation from stored logs (verify names are in the log first).
7. Replay flags: timestamped bookmarks on the match record, markers on the scrubber, carried in
   shares.

**Tier 3 — new surface area, needs its own design doc:**
8. Pre-match scouting in the popup + per-matchup notes.
9. Share a whole series (already noted in the sharing spec as future Worker work).

**Investigate before promising:** TCG-Arena capture support — their biggest real edge over us, and
our biggest maintenance commitment if taken on.

**Deliberately not doing:** community stats, accounts, teams (identity inversion; ADR 0001);
drawing/audio annotations and MP4 export (cost/fit); OBS overlay (unless streamers ask).

## Sources

- https://www.riftlite.com/ — feature overview
- https://www.riftlite.com/guide, /about, /download — workflows, platforms
- https://www.riftlite.com/community/matrix, /community/decks — community data scope
- Internal: `docs/specs/`, `docs/plans/`, `docs/adr/0001-remain-on-the-workers-free-plan.md`,
  outstanding-issues list in `docs/plans/2026-08-10-replay-sharing-implementation.md`
