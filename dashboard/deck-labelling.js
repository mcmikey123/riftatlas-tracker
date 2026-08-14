/* Rift Atlas Stats Tracker - naming decks in bulk
 *
 * Three ways to put a name on more than one match at a time: label every
 * unlabelled match, apply one match's name to the rest of that champion's
 * unlabelled games, and recognise decks from the cards actually played.
 *
 * The recognition itself is fingerprint.js, which is pure and tested. What is
 * here is the flow around it - a dialog per decision, then one write - and two
 * rules that hold across all three:
 *
 *   NOTHING IS GUESSED. A group left unnamed, a match that sits between two
 *   decks, a match with too little card data: all keep "— unlabelled —" rather
 *   than being given a name nobody chose.
 *
 *   THE TARGETS ARE RE-RESOLVED AFTER THE DIALOG, BY ID. A dialog does not
 *   block the event loop the way confirm() did, so a reload arriving while one
 *   is open replaces the match array with fresh objects - and the list captured
 *   before it would then be mutating records that are no longer in the array
 *   being saved, reporting success having written nothing.
 *
 * A name applied by any of these is marked manual or fingerprint, which is what
 * stops detection overwriting it later.
 */
(function (root) {
  "use strict";

  const { esc, champ } = root.RATrackerFormat || require("./format.js");
  const { say, ask, dialog } = root.RATrackerNotify || require("./notify.js");
  // Reached at call time: storage.js is the dashboard's only writer, and
  // fingerprint.js is only needed once a button has been pressed.
  const STORE = () => root.RATrackerStorage;
  const FP = () => root.RATrackerFingerprint;

  const $ = (s) => document.querySelector(s);
  const on = (sel, type, fn) => {
    const el = $(sel);
    if (el) el.addEventListener(type, fn);
    return el;
  };
  const val = (sel) => {
    const el = $(sel);
    return el ? el.value : "";
  };

  // Supplied by mount(). `repaint` is the filter options and the render that
  // every one of these writes ends with: a new deck name has to reach the
  // filter row and every other row's picker.
  let matches = () => [];
  let readOnly = () => false;
  let repaint = () => {};

  // ---- who gets a name ---------------------------------------------------

  /**
   * The matches a bulk label would touch: those with no name of their own.
   *
   * `champion` narrows it to one champion, which is what the My champion filter
   * does and what "apply to unlabelled X games" means. Empty means all of them.
   *
   * Asked twice per flow - once to size the dialog, once after it closes - so
   * it is one function rather than four copies of the predicate.
   */
  const unlabelled = (all, champion) =>
    (all || []).filter(
      (m) =>
        !(m.deckName || "").trim() &&
        (!champion || champ(m.myChampion || m.myLegend) === champion)
    );

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "es"}`;

  /** Name every unlabelled match, or every unlabelled match of one champion. */
  function bulkPrompt(count, champion) {
    const scope = champion
      ? `${count} unlabelled ${champion} match`
      : `${count} unlabelled match`;
    return {
      title: `Name ${scope}${count === 1 ? "" : "es"}`,
      sub: champion
        ? `Only ${champion} matches, because that is the champion filter you have set.`
        : "Set the My champion filter first to label one champion at a time.",
      label: "Deck name",
      confirmLabel: "Label them",
      validate: (v) => (v.trim() ? null : "Give the deck a name, or cancel."),
    };
  }

  /**
   * Write `name` onto every currently-unlabelled match in scope.
   *
   * The array is re-filtered here rather than taking a list, which is what
   * makes "after the dialog, by id" true of every caller: the objects mutated
   * are the ones in the array being written.
   */
  function applyName(champion, name) {
    const all = matches();
    const now = unlabelled(all, champion);
    if (!now.length) return say("Those matches have already been labelled.");
    now.forEach((m) => {
      m.deckName = name;
      m.deckSource = "manual";
    });
    STORE().writeMatches(all, () => {
      repaint();
      say(`Labelled ${plural(now.length, "match")} as “${name}”.`, "success");
    });
  }

  // ---- the fingerprint flows ---------------------------------------------

  /** One line per group, for the summary block inside the dialog. */
  const clusterLines = (clusters) =>
    clusters
      .map((c, i) => `  Group ${i + 1}: ${plural(c.size, "match")} (${c.cards} distinct cards)`)
      .join("\n");

  /**
   * What the detector found, in the words the confirm shows.
   *
   * The average overlap is the number that says how confident this is, and the
   * count left alone is the promise that nothing was guessed - so both are
   * computed here rather than in the markup.
   */
  function proposalDialog(proposals, undecided) {
    const byDeck = {};
    proposals.forEach((p) => {
      byDeck[p.deck] = (byDeck[p.deck] || 0) + 1;
    });
    const summary = Object.entries(byDeck)
      .map(([d, n]) => `  ${n} × “${d}”`)
      .join("\n");
    const avg = Math.round((proposals.reduce((a, p) => a + p.score, 0) / proposals.length) * 100);
    return {
      title: "Decks detected from cards played",
      sub: `${proposals.length} unlabelled game${proposals.length === 1 ? "" : "s"} matched, average ${avg}% card overlap`,
      body:
        "<p>Matched against decks you have already named:</p>" +
        `<pre class="ra-dialog-summary">${esc(summary)}</pre>` +
        (undecided.length
          ? `<p>${undecided.length} left alone — too little card data, or no clear winner. ` +
            "Nothing is guessed: those keep <em>— unlabelled —</em>.</p>"
          : ""),
      summary: "Names you typed yourself are never touched.",
      confirmLabel: `Apply ${proposals.length} label${proposals.length === 1 ? "" : "s"}`,
    };
  }

  /* Name each detected group, one dialog at a time.
   *
   * This was `clusters.forEach(...)` around a native prompt, which worked only
   * because prompt() blocks. An async callback inside forEach would open every
   * dialog at once and reach the write with nothing named, so the loop has to
   * be a real `for ... of` with an await in it.
   *
   * An unnamed group is simply left unlabelled - nothing is guessed, which is
   * the same promise the undecided matches get. */
  async function nameClusters(clusters, lines) {
    const ok = await ask({
      title: `Found ${clusters.length} distinct deck${clusters.length === 1 ? "" : "s"}`,
      sub: "Grouped by the cards each game actually showed",
      body:
        "<p>You will be asked to name each group in turn. Leave one blank to skip it — " +
        "an unnamed group keeps <em>— unlabelled —</em> rather than being guessed at.</p>" +
        `<pre class="ra-dialog-summary">${esc(lines)}</pre>`,
      confirmLabel: "Name them",
    });
    if (!ok) return;

    const named = new Map();
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      const name = await dialog().textPrompt({
        title: `Group ${i + 1} of ${clusters.length}`,
        sub: `${plural(c.size, "match")} · ${c.cards} distinct cards`,
        label: "Deck name",
        placeholder: "Leave blank to skip",
        confirmLabel: i + 1 === clusters.length ? "Finish" : "Next",
      });
      const clean = (name || "").trim();
      if (clean) named.set(c, clean);
    }
    if (!named.size) return;

    const all = matches();
    let count = 0;
    for (const [c, clean] of named) {
      const ids = new Set(c.ids);
      all.forEach((m) => {
        if (!ids.has(m.id)) return;
        m.deckName = clean;
        m.deckSource = "fingerprint";
        count++;
      });
    }
    if (!count) return say("Those matches have already been labelled.");
    STORE().writeMatches(all, () => {
      repaint();
      say(`Labelled ${plural(count, "match")}.`, "success");
    });
  }

  /** Recognise decks from the cards actually played. */
  function detectDecks() {
    if (readOnly()) return;
    const fp = FP();
    chrome.storage.local.get(null, (data) => {
      const all = matches();
      const prints = new Map();
      for (const m of all) {
        const r = data["deckcards_" + m.id];
        prints.set(m.id, fp.fingerprint(r && r.codes));
      }
      const withCards = [...prints.values()].filter((s) => s.size >= fp.MIN_CARDS).length;
      if (!withCards) {
        return dialog().alert({
          title: "No usable card data yet",
          body:
            "<p>Deck recognition compares the cards you actually played, so it needs matches " +
            `where at least ${fp.MIN_CARDS} of your own cards were seen on the board.</p>` +
            "<p>Play a few more matches with the extension running and try again.</p>",
        });
      }
      const { proposals, undecided, labelledCount } = fp.suggestLabels(all, prints);

      if (!labelledCount) {
        // Nothing labelled yet: group them instead and let the user name each.
        const clusters = fp.clusterDecks(all, prints);
        if (!clusters.length) return say("Not enough card data to group these matches yet.");
        nameClusters(clusters, clusterLines(clusters));
        return;
      }

      if (!proposals.length) {
        return dialog().alert({
          title: "No confident matches found",
          sub: `${plural(undecided.length, "match")} could not be placed`,
          body:
            "<p>Nothing is guessed: a match that sits between two decks keeps " +
            "<em>— unlabelled —</em> and can be labelled by hand in Matches.</p>" +
            "<ul>" +
            undecided.slice(0, 6).map((u) => `<li>${esc(u.reason)}</li>`).join("") +
            "</ul>",
        });
      }

      ask(proposalDialog(proposals, undecided)).then((ok) => {
        if (!ok) return;
        const byId = new Map(proposals.map((p) => [p.match.id, p.deck]));
        // By id, so a reload during the dialog cannot leave this writing to
        // objects that are no longer in the array being saved.
        const live = matches();
        let applied = 0;
        live.forEach((m) => {
          if (!byId.has(m.id) || (m.deckName || "").trim()) return;
          m.deckName = byId.get(m.id);
          m.deckSource = "fingerprint";
          applied++;
        });
        if (!applied) return say("Those matches have already been labelled.");
        STORE().writeMatches(live, () => {
          repaint();
          say(`Labelled ${plural(applied, "match")}.`, "success");
        });
      });
    });
  }

  // ---- the controls ------------------------------------------------------

  /* One attribute, `data-deckapply`, drawn by the Matches view's expanded row.
   * Nothing else listens for it, and the click carries no other attribute this
   * page acts on. */
  function mount(deps) {
    matches = deps.matches;
    readOnly = deps.readOnly;
    repaint = deps.repaint;

    // Bulk-label every unlabelled match, respecting the champion filter so you
    // can do one champion at a time when you play several.
    on("#bulkLabel", "click", () => {
      if (readOnly()) return;
      const champion = val("#fMyChampion");
      const targets = unlabelled(matches(), champion);
      if (!targets.length) return say("Every match already has a deck name.");
      dialog()
        .textPrompt(bulkPrompt(targets.length, champion))
        .then((name) => {
          const clean = (name || "").trim();
          if (!clean) return;
          applyName(champion, clean);
        });
    });

    on("#autoDeck", "click", detectDecks);

    document.addEventListener("click", (e) => {
      const applyId = e.target?.dataset?.deckapply;
      if (!applyId || readOnly()) return;
      const src = matches().find((x) => x.id === applyId);
      // The picker commits on change, so the record is already the truth.
      const name = (src?.deckName || "").trim();
      if (!name) return say("Give this match a deck name first.", "error");
      const champion = champ(src.myChampion || src.myLegend);
      const targets = unlabelled(matches(), champion);
      if (!targets.length) return say(`No unlabelled ${champion} matches to update.`);
      ask({
        title: `Label ${plural(targets.length, "match")} as “${name}”?`,
        body: `<p>Every unlabelled ${esc(champion)} match takes this name, and a name applied
               here is marked manual, so detection will not overwrite it.</p>`,
        confirmLabel: `Label ${targets.length}`,
      }).then((ok) => {
        if (ok) applyName(champion, name);
      });
    });
  }

  root.RATrackerDeckLabelling = {
    unlabelled,
    bulkPrompt,
    clusterLines,
    proposalDialog,
    mount,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerDeckLabelling;
}
