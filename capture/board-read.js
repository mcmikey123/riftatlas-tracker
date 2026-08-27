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
 * actor bar on a log row) it is matched on the colour it encodes and backed by
 * a fallback.
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

  /* Which side is on turn, from the ids the board root carries. Null when it
   * names nobody, or names somebody who is neither of the two players. */
  function activeSide(board) {
    const d = board?.dataset;
    if (!d || !d.activePlayerId) return null;
    if (d.viewerPlayerId && d.activePlayerId === d.viewerPlayerId) return "self";
    if (d.opponentPlayerId && d.activePlayerId === d.opponentPlayerId) {
      return "opponent";
    }
    return null;
  }

  // ---------- player names ----------
  //
  // Each player has an identity badge that says which side it belongs to and
  // carries the name in its aria-label ("curtyo menu").
  const BADGE = {
    mine: '[data-player-identity-trigger="player"]',
    opponent: '[data-player-identity-trigger="opponent"]',
  };
  const MENU_SUFFIX_RE = /\s*menu$/i;

  function badgeName(selector) {
    const label = document.querySelector(selector)?.getAttribute("aria-label");
    const name = (label || "").replace(MENU_SUFFIX_RE, "").trim();
    return name || null;
  }

  /* The letter rails the badges replaced: names spelled out one character per
   * span, rotated, and told apart by which of them sits in a container
   * positioned from the left.
   *
   * Kept as the fallback, but it is the weakest reading in this file and the
   * only one whose failure is a wrong answer rather than no answer - the rail
   * selector matches the badges' own inner grid too, so the pool it picks the
   * FIRST match from is no longer only rails. The single-character filter is
   * all that currently keeps a badge out of it. */
  function railNames() {
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

  function playerNames() {
    const names = {
      mine: badgeName(BADGE.mine),
      opponent: badgeName(BADGE.opponent),
    };
    if (names.mine && names.opponent) return names;
    // One badge read is not the other's problem: fill only what is missing.
    const rails = railNames();
    return {
      mine: names.mine || rails.mine,
      opponent: names.opponent || rails.opponent,
    };
  }

  /* Both scores come off the board root, next to the authoritative sequence
   * the server stamps there - so they are the same reading for both players,
   * and neither depends on how the track happens to be drawn this month.
   *
   * The tracks themselves are the fallback, and they hold no number: each node
   * draws an SVG constellation and puts its value in the aria-label alone
   * ("Set your score to 4"). The current node is `data-active`, which both
   * tracks carry; `aria-pressed` is only on the track you can click, so it is
   * tried second rather than first. A track that says neither reads as null.
   */
  const NODE_VALUE_RE = /(\d+)\s*$/;

  function trackScore(selector) {
    const group = document.querySelector(selector);
    if (!group) return null;
    const current =
      group.querySelector('[data-active="true"]') ||
      group.querySelector('[aria-pressed="true"]');
    const hit = NODE_VALUE_RE.exec(current?.getAttribute("aria-label") ?? "");
    const n = hit ? parseInt(hit[1], 10) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  function rootScore(board, key, selector) {
    const n = parseInt(board?.dataset[key] ?? "", 10);
    return Number.isFinite(n) ? n : trackScore(selector);
  }

  const myScore = (board) => rootScore(board, "viewerScore", SEL.myScoreGroup);
  const opponentScore = (board) =>
    rootScore(board, "opponentScore", SEL.oppScoreGroup);

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
    activeSide,
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
