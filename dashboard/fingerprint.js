/* Rift Atlas Stats Tracker - deck fingerprinting
 *
 * Replays record every card of YOURS that became visible during a match, so
 * each game carries a partial sample of the deck you were playing. Two games
 * on the same deck overlap heavily; a different variant does not. That's
 * enough to group matches by deck without ever seeing a decklist.
 *
 * Because a sample is partial (you only see what you drew), similarity uses
 * the overlap coefficient - |A∩B| / min(|A|,|B|) - rather than Jaccard, which
 * would unfairly punish a short game against a long one.
 */
(function (root) {
  "use strict";

  // Zones that reflect deck contents. Legend/champion are excluded: they're
  // identical across variants of the same champion, so they'd blur exactly
  // the distinction we're trying to draw.
  const DECK_ZONES = ["battlefieldA", "battlefieldB", "base", "hand", "trash", "runeArea"];
  const MIN_CARDS = 6; // below this a sample is too thin to judge
  const THRESHOLD = 0.5; // overlap needed to call it the same deck
  // Clustering compares against a cluster REPRESENTATIVE, never the growing
  // union: a union accumulates every variant's tech cards, so the shared core
  // eventually matches everything and all decks collapse into one group.
  const CLUSTER_THRESHOLD = 0.6;
  const MARGIN = 0.05; // best deck must beat the runner-up by this much

  /** Set of your own card codes seen across a replay. */
  function fingerprint(snaps) {
    const codes = new Set();
    if (!Array.isArray(snaps)) return codes;
    for (const s of snaps) {
      const z = (s && s.z) || {};
      for (const zone of DECK_ZONES) {
        const list = z["self." + zone];
        if (!Array.isArray(list)) continue;
        for (const c of list) if (c && !c.h && c.c) codes.add(c.c);
      }
    }
    return codes;
  }

  function overlap(a, b) {
    if (!a.size || !b.size) return 0;
    let hits = 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const c of small) if (large.has(c)) hits++;
    return hits / small.size;
  }

  /**
   * For each unlabelled match, find the best-matching labelled match and
   * propose its deck name. Returns proposals plus the ones left undecided.
   */
  function suggestLabels(matches, prints, opts) {
    const threshold = (opts && opts.threshold) || THRESHOLD;
    const minCards = (opts && opts.minCards) || MIN_CARDS;
    const labelled = matches.filter((m) => (m.deckName || "").trim());
    const unlabelled = matches.filter((m) => !(m.deckName || "").trim());
    const proposals = [];
    const undecided = [];

    for (const m of unlabelled) {
      const fp = prints.get(m.id);
      if (!fp || fp.size < minCards) {
        undecided.push({ match: m, reason: fp ? `only ${fp.size} cards seen` : "no replay" });
        continue;
      }
      // Best score per DECK, so a deck with many reference games doesn't
      // simply out-vote a better-matching one.
      const perDeck = new Map();
      for (const l of labelled) {
        const lp = prints.get(l.id);
        if (!lp || lp.size < minCards) continue;
        const name = l.deckName.trim();
        const score = overlap(fp, lp);
        if (!perDeck.has(name) || score > perDeck.get(name)) perDeck.set(name, score);
      }
      const ranked = [...perDeck.entries()].sort((a, b) => b[1] - a[1]);
      const best = ranked[0];
      const runnerUp = ranked[1];
      if (!best) {
        undecided.push({ match: m, reason: "nothing labelled to compare with" });
      } else if (best[1] < threshold) {
        undecided.push({ match: m, reason: `best match only ${Math.round(best[1] * 100)}%` });
      } else if (runnerUp && best[1] - runnerUp[1] < MARGIN) {
        // Too close to call - guessing here would quietly corrupt the stats.
        undecided.push({
          match: m,
          reason: `ambiguous: “${best[0]}” ${Math.round(best[1] * 100)}% vs “${runnerUp[0]}” ${Math.round(runnerUp[1] * 100)}%`,
        });
      } else {
        proposals.push({ match: m, deck: best[0], score: best[1], cards: fp.size });
      }
    }
    return { proposals, undecided, labelledCount: labelled.length };
  }

  /**
   * Group matches that look like the same deck, without needing any labels.
   * Greedy single-link clustering, largest samples first.
   */
  function clusterDecks(matches, prints, opts) {
    const threshold = (opts && opts.threshold) || CLUSTER_THRESHOLD;
    const minCards = (opts && opts.minCards) || MIN_CARDS;
    const usable = matches
      .filter((m) => {
        const fp = prints.get(m.id);
        return fp && fp.size >= minCards;
      })
      .sort((a, b) => prints.get(b.id).size - prints.get(a.id).size);

    const clusters = [];
    for (const m of usable) {
      const fp = prints.get(m.id);
      let bestCl = null;
      let bestScore = 0;
      for (const cl of clusters) {
        const score = overlap(fp, cl.rep); // representative, not union
        if (score > bestScore) { bestScore = score; bestCl = cl; }
      }
      if (bestCl && bestScore >= threshold) {
        bestCl.ids.push(m.id);
        for (const c of fp) bestCl.union.add(c);
      } else {
        // First (largest) sample of a deck becomes its fixed representative.
        clusters.push({ ids: [m.id], rep: new Set(fp), union: new Set(fp) });
      }
    }
    return clusters
      .map((c) => ({ ids: c.ids, size: c.ids.length, cards: c.union.size }))
      .sort((a, b) => b.size - a.size);
  }

  root.RATrackerFingerprint = {
    fingerprint, overlap, suggestLabels, clusterDecks,
    DECK_ZONES, MIN_CARDS, THRESHOLD,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerFingerprint;
}
