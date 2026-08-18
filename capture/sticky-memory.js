/* Rift Atlas Stats Tracker - remembering something the page stops showing.
 *
 * Two facts about a match are stated before it starts and gone by the time the
 * board mounts: which deck was picked, and whether the lobby is Bo1 or Bo3.
 * Neither can be read when it is finally needed, so both are read while they
 * are on screen, kept in memory, and mirrored into chrome.storage.local against
 * a reload or a game opened in a fresh tab.
 *
 * The two used to be written out twice, comments and all, differing only in the
 * storage key, the reader and the equality test. This is that sequence once:
 *
 *   - a floor between reads, because mutation-driven calls arrive every frame
 *     on this site and neither fact can change faster than a click;
 *   - a restamp on every sighting, so `at` means "last seen on screen" rather
 *     than "last changed" - a deck left open for an hour must not age out from
 *     under the player;
 *   - a throttled mirror: written on change, and refreshed now and then while
 *     the thing sits on screen, so a long wait in the lobby does not look stale
 *     to the next page load;
 *   - a load that yields to anything already read live from the page.
 *
 * WHAT IS STORED IS THE READER'S OWN SHAPE, plus `at`. The caller says what a
 * sighting looks like ({name, champion} for the deck, {format} for the lobby)
 * and that object, stamped, is what goes under its key - so the two on-disk
 * shapes this replaced are still exactly what is written and read today, and an
 * install that remembers a deck keeps remembering it. Storing some normalised
 * {value, at} instead would have been the same code with a migration attached;
 * making the shape a parameter costs nothing and needs no migration at all.
 *
 * Ageing is deliberately NOT here. How long a memory stays usable is a
 * judgement about the thing remembered, not about remembering, and both callers
 * take that window from capture/deck-name.js at the one place they use it.
 */
(function (root) {
  "use strict";

  const READ_MIN_MS = 250; // floor between reads when mutations drive them
  const STAMP_MS = 30000; // how often to refresh the stored "last seen"

  /**
   * @param {object} config
   * @param {string} config.key - chrome.storage.local key to mirror into.
   * @param {function(): ?object} config.read - one sighting, or null when the
   *   thing is not on screen. Its shape is what gets stored.
   * @param {function(object, object): boolean} config.same - is this sighting
   *   the same one we already hold? Decides logging and the write.
   * @param {function(object): boolean} config.isStored - is a value read back
   *   out of storage worth restoring? Guards a half-written or empty record.
   * @param {function(object)} [config.onChange] - called with the stamped value
   *   when the sighting differs from the one held. Callers log here; this
   *   module does not, since the sentence belongs to the thing being watched.
   * @param {function(): number} [config.now] - epoch ms. Injectable so the
   *   sequencing above can be driven by a test rather than by wall clock.
   */
  function createStickyMemory(config) {
    const { key, read, same, isStored, onChange } = config;
    const now = config.now || Date.now;

    let held = null;
    let readAt = 0;
    let savedAt = 0;

    function watch() {
      const at = now();
      if (at - readAt < READ_MIN_MS) return;
      readAt = at;

      const found = read();
      if (!found) return;
      const changed = !held || !same(held, found);
      held = Object.assign({}, found, { at });
      if (changed && onChange) onChange(held);
      if (!changed && at - savedAt < STAMP_MS) return;
      savedAt = at;
      try {
        chrome.storage.local.set({ [key]: held });
      } catch (_) {
        /* An orphaned content script cannot reach storage; the next page load
         * simply starts without a memory, which is what it did before there
         * was one. Nothing here is worth a banner. */
      }
    }

    /** Restore across reloads / a newly opened game tab. */
    function load() {
      try {
        chrome.storage.local.get({ [key]: null }, (data) => {
          const stored = data && data[key];
          // Anything read live from the page beats what storage remembers.
          if (stored && isStored(stored) && !held) held = stored;
        });
      } catch (_) {}
    }

    return { watch, load, get: () => held };
  }

  root.RATSticky = { createStickyMemory, READ_MIN_MS, STAMP_MS };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATSticky;
}
