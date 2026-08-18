/* Rift Atlas Stats Tracker - deck fingerprinting
 *
 * While a match is played, content.js accumulates every card code of YOURS
 * that became visible and stores it under deckcards_<matchId>, so each game
 * carries a partial sample of the deck you were playing. Two games on the same
 * deck overlap heavily; a different variant does not. That's enough to group
 * matches by deck without ever seeing a decklist.
 *
 * Because a sample is partial (you only see what you drew), similarity uses
 * the overlap coefficient - |A∩B| / min(|A|,|B|) - rather than Jaccard, which
 * would unfairly punish a short game against a long one.
 */
(function (root) {
  "use strict";

  // The zones content.js harvests those codes from - the contract between the
  // two files. Legend/champion are excluded: they're identical across variants
  // of the same champion, so they'd blur exactly the distinction we're drawing.
  // Nothing in this file reads it: it is the dashboard half of the mirror that
  // test/shared-constants.test.js pins against content.js, so deleting it as
  // unused would drop the only check that the two lists still agree.
  const DECK_ZONES = ["battlefieldA", "battlefieldB", "base", "hand", "trash", "runeArea"];
  const MIN_CARDS = 6; // below this a sample is too thin to judge
  const THRESHOLD = 0.5; // overlap needed to call it the same deck
  // Clustering compares against a cluster REPRESENTATIVE, never the growing
  // union: a union accumulates every variant's tech cards, so the shared core
  // eventually matches everything and all decks collapse into one group.
  const CLUSTER_THRESHOLD = 0.6;
  const MARGIN = 0.05; // best deck must beat the runner-up by this much

  /** Set of your own card codes seen in a match, from its stored `codes`. */
  function fingerprint(codes) {
    const out = new Set();
    if (!Array.isArray(codes)) return out;
    for (const c of codes) if (c) out.add(c);
    return out;
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
        undecided.push({ match: m, reason: fp ? `only ${fp.size} cards seen` : "no card data" });
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
    MIN_CARDS,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerFingerprint;
}
