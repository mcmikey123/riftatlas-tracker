/* Rift Atlas Stats Tracker - Bo1 or Bo3?
 *
 * Stated in the lobby and gone by the time the board mounts - the same problem
 * the deck picker has, solved the same way: read it while it is on screen,
 * remember it (capture/sticky-memory.js), and use the memory when the match
 * begins.
 *
 * Two selectors because there are two lobbies. Whoever HOSTS picks the format on
 * a two-button group, where the chosen button carries aria-pressed="true".
 * Whoever JOINS a hosted Bo3 never sees those buttons - they get a one-line
 * summary whose title spells the format out ("1v1 · Constructed · Best of 3 ·
 * Standard").
 *
 * Neither path matches on class names. This site's classes are generated
 * utilities with literal colour values baked in ("border-[rgba(116,239,255,
 * 0.42)]") and are rewritten every restyle; aria-pressed and title describe
 * behaviour rather than styling, so they survive one.
 */
(function (root) {
  "use strict";

  const FORMAT_RE = /Best of\s+(\d+)/i;

  const cleanText = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

  /**
   * The format the lobby is showing, or null if it isn't saying.
   * Only Bo1 and Bo3 exist. A number we don't recognise means the read went
   * somewhere unexpected, and null is safer than inventing a format for it.
   */
  function readMatchFormat(scopeRoot) {
    const scope = scopeRoot || document;
    let hit = null;
    // Host path: the pressed button of the format toggle.
    for (const btn of scope.querySelectorAll('button[aria-pressed="true"]')) {
      hit = FORMAT_RE.exec(cleanText(btn));
      if (hit) break;
    }
    // Join path. Sweeping every [title] in the document is safe here: this
    // summary line only ever describes the one game being hosted or joined,
    // never a row of a browsable list, so there is nothing else to hit.
    if (!hit) {
      for (const el of scope.querySelectorAll("[title]")) {
        hit = FORMAT_RE.exec(el.getAttribute("title") || "");
        if (hit) break;
      }
    }
    if (!hit) return null;
    if (hit[1] === "1") return "bo1";
    if (hit[1] === "3") return "bo3";
    return null;
  }

  /* How long a format stays usable after the lobby that stated it left the
   * screen. Deliberately NOT the deck picker's window, which this borrowed
   * until a Bo1 joined by room code was filed as a Bo3 two hours after an
   * unrelated Bo3 lobby was last on screen.
   *
   * The deck can afford a long memory because it is checked again at the end:
   * capture/deck-name.js re-reads the legend off the board and drops a name
   * the board contradicts. Nothing on the board states the format - a live
   * read there returns null - so a format has exactly one chance to be right
   * and no way to be corrected. The window is what limits the damage, and it
   * only has to span the walk from the lobby to the board. */
  const FORMAT_MEMORY_MS = 10 * 60 * 1000;

  let lobby = null;

  /* Its own storage key for the same reasons `activeDeck` has one: the lobby
   * unmounts the moment the board mounts, the game may be opened in a fresh tab
   * between hosting and playing, and a write here must not clobber a settings
   * write happening in the dashboard at the same moment.
   *
   * Built on first use rather than at load - see capture/deck-scan.js. */
  function memory() {
    if (!lobby) {
      lobby = root.RATSticky.createStickyMemory({
        key: "activeFormat",
        read: () => {
          const found = readMatchFormat();
          return found ? { format: found } : null;
        },
        same: (held, found) => held.format === found.format,
        isStored: (stored) => !!stored.format,
        onChange: (seen) => console.info("[RA-Tracker] lobby format:", seen.format),
      });
    }
    return lobby;
  }

  /**
   * The format to file a starting match under, and where it came from.
   *
   * @returns {{format: "bo1"|"bo3", source: "live"|"memory"}|null}
   *   null when nothing can say.
   *
   * The lobby is normally already gone by the time the board mounts, so the
   * live read is the bonus case and the remembered one does the real work -
   * which is exactly why the caller is told which it got. A live read watched
   * the player choose; a remembered one is an inference about a screen that is
   * no longer there, and a match joined by room code can inherit one from a
   * lobby it has nothing to do with. dashboard/series.js will not build a
   * series around a single game on the strength of the second.
   */
  function current() {
    const live = readMatchFormat();
    if (live) return { format: live, source: "live" };
    const held = memory().get();
    const usable = !!held && Date.now() - (held.at || 0) < FORMAT_MEMORY_MS;
    return usable ? { format: held.format, source: "memory" } : null;
  }

  root.RATMatchFormat = {
    watch: () => memory().watch(),
    load: () => memory().load(),
    current,
    FORMAT_MEMORY_MS,
    // Reached by tests; the extension itself only ever goes through `current`.
    readMatchFormat,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATMatchFormat;
}
