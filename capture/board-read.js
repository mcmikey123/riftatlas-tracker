/* Rift Atlas Stats Tracker - everything we read off the game board.
 *
 * One place for the scrapes, so the record and the decisions made from it never
 * touch the DOM. Every function here answers with plain data and answers null
 * when the board is not saying: an unreadable score track is not a zero, and a
 * name we could not find is not an empty name - the callers all treat "no
 * reading" as "keep what you had", which only works if a miss is distinguishable.
 *
 * None of these match on class names except where the site gives us nothing
 * else. This site's classes are generated utilities with literal colour values
 * baked in and are rewritten every restyle, so where one is unavoidable (the
 * opponent's score track, the actor bar on a log row) it is matched on the
 * colour it encodes and backed by a fallback.
 */
(function (root) {
  "use strict";

  const SEL = {
    root: '[data-testid="game-state"]',
    roomCode: '[data-testid="room-code"]',
    myScoreGroup: '[role="group"][aria-label="Your score track"]',
    oppScoreGroup: '[role="group"][aria-label="Opponent score track"]',
  };

  // Match-log actor colours (left bar on each log row).
  const ACTOR_SELF = "120,221,183"; // green
  const ACTOR_OPP = "255,187,110"; // amber

  /** The board itself, or null on any of the site's own pages. */
  function gameRoot() {
    return document.querySelector(SEL.root);
  }

  const phase = (board) => board?.dataset.roomPhase || null;
  const mode = (board) => board?.dataset.roomMode || null;
  const roomCode = () =>
    document.querySelector(SEL.roomCode)?.dataset.roomCode || null;

  /** The turn showing on the board, or null when it cannot be read. */
  function turnNumber(board) {
    const n = parseInt(board?.dataset.turnNumber ?? "", 10);
    return Number.isFinite(n) ? n : null;
  }

  function cardAlt(zoneOwner, dropZone) {
    // e.g. section[data-zone-owner="opponent"] ... [data-drop-zone="champion"] img[alt]
    const owners = document.querySelectorAll(`[data-zone-owner="${zoneOwner}"]`);
    for (const owner of owners) {
      const img = owner.querySelector(`[data-drop-zone="${dropZone}"] img[alt]`);
      if (img && img.alt && !/hidden card|card back/i.test(img.alt)) return img.alt;
    }
    return null;
  }

  function playerNames() {
    // Player names are rendered as vertical letter rails next to the score tracks.
    // rotate-90 letters read top-to-bottom in order; -rotate-90 read reversed.
    const names = { mine: null, opponent: null };
    try {
      const rails = document.querySelectorAll(
        ".grid.content-center.justify-items-center"
      );
      for (const rail of rails) {
        const spans = [...rail.querySelectorAll("span")].filter(
          (s) => s.textContent.length === 1
        );
        if (spans.length < 2) continue;
        const reversed = spans[0].className.includes("-rotate-90");
        let letters = spans.map((s) => s.textContent).join("");
        if (reversed) letters = [...letters].reverse().join("");
        // Rail inside the LEFT (your) track area = your name; right = opponent.
        // Heuristic: the left rail container mentions "left-[" positioning.
        const container = rail.closest('div[class*="absolute"]');
        const isLeft = container && /(^|\s|\[)left-/.test(container.className);
        if (isLeft && !names.mine) names.mine = letters;
        else if (!names.opponent) names.opponent = letters;
      }
    } catch (_) {
      /* names are optional */
    }
    return names;
  }

  function myScore() {
    const group = document.querySelector(SEL.myScoreGroup);
    if (!group) return null;
    const active = group.querySelector('[aria-pressed="true"] span');
    const n = active ? parseInt(active.textContent, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  function opponentScore() {
    const group = document.querySelector(SEL.oppScoreGroup);
    if (!group) return null;
    // Opponent nodes have no aria-pressed; the current one carries a distinct
    // amber highlight. Fall back to the node with the longest class string.
    const nodes = [...group.children];
    if (!nodes.length) return null;
    let current =
      nodes.find((n) => n.className.includes("108,75,39")) || // amber gradient
      nodes.find((n) => n.className.includes("255,224,181")); // amber ring
    if (!current) {
      current = nodes.reduce((a, b) =>
        a.className.length >= b.className.length ? a : b
      );
    }
    const n = parseInt(current.querySelector("span")?.textContent ?? "", 10);
    return Number.isFinite(n) ? n : null;
  }

  // ---------- match log ----------
  //
  // A log row looks like:
  //   <li><span aria-hidden bar-colour></span>
  //       <p><span><span>16:11</span><span>Conquered <b>X</b> and scored 1.</span></span>…</p></li>
  //
  // Chat rows are the same shape but render their own header and repeat the
  // time after the message; capture/match-log.js takes those repeats back out.
  function parseLogLi(li) {
    const p = li.querySelector("p");
    if (!p) return null;
    const spans = [...p.querySelectorAll("span")];
    // This shape check is load-bearing beyond finding the time: `t` reaches
    // match-log.js's RegExps unescaped, and digits-and-a-colon is what keeps
    // that safe.
    const timeIdx = spans.findIndex((s) =>
      /^\d{1,2}:\d{2}$/.test((s.textContent || "").trim())
    );
    if (timeIdx < 0) return null;
    const t = spans[timeIdx].textContent.trim();
    // Use the wrapper span so nested <b>/<span> formatting is included.
    const holder = spans[timeIdx].parentElement || p;
    const text = root.RATMatchLog.stripRepeatedTime(
      (holder.textContent || "").trim(),
      t
    );
    if (!text) return null;
    const bar = li.querySelector('span[aria-hidden="true"]');
    const cls = (bar && bar.className) || "";
    const actor = cls.includes(ACTOR_SELF)
      ? "self"
      : cls.includes(ACTOR_OPP)
      ? "opponent"
      : "system";
    return { t, actor, text };
  }

  /** The whole log panel, oldest first. Empty when there is nothing to read. */
  function logEntries() {
    let lis;
    try {
      lis = document.querySelectorAll("ul li");
    } catch (_) {
      return [];
    }
    const entries = [];
    for (const li of lis) {
      const e = parseLogLi(li);
      if (e) entries.push(e);
    }
    // The panel renders newest-first; reverse for chronological order.
    entries.reverse();
    return entries;
  }

  root.RATBoard = {
    gameRoot,
    phase,
    mode,
    roomCode,
    turnNumber,
    cardAlt,
    playerNames,
    myScore,
    opponentScore,
    logEntries,
    parseLogLi,
    SEL,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATBoard;
}
