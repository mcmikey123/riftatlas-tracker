/* Rift Atlas Stats Tracker - game-log analysis
 *
 * Turns captured match-log lines into playstyle metrics. Patterns are
 * deliberately easy to extend: unmatched lines are counted so you can see
 * how much of a game the analysis actually understood.
 */
(function (root) {
  "use strict";

  // Order matters: first match wins.
  const PATTERNS = [
    { key: "trash", re: /\bto trash\b/i },
    { key: "conquer", re: /\bconquered\b/i, points: /scored\s+(\d+)/i },
    { key: "score", re: /\bscored\s+(\d+)/i, points: /scored\s+(\d+)/i },
    { key: "commit", re: /^moved\s+.+\bto\b\s+(?!hand|deck|trash)/i },
    { key: "showdown", re: /\bshowdown\b/i },
    { key: "passFocus", re: /\bpassed focus\b/i },
    { key: "endTurn", re: /\bended (their|your|the) turn\b/i },
    { key: "play", re: /^played\b/i },
    { key: "draw", re: /^(drew|draws)\b/i },
    { key: "mulligan", re: /\bmulligan\b/i },
    { key: "phase", re: /\b(beginning|draw|main|ending) phase\b/i },
  ];

  function blankSide() {
    return {
      commit: 0, conquer: 0, score: 0, trash: 0, showdown: 0,
      passFocus: 0, endTurn: 0, play: 0, draw: 0, mulligan: 0,
      phase: 0, other: 0, points: 0, total: 0,
    };
  }

  function analyse(match) {
    const log = Array.isArray(match && match.log) ? match.log : [];
    const out = {
      hasLog: log.length > 0,
      lines: log.length,
      self: blankSide(),
      opponent: blankSide(),
      system: blankSide(),
      unmatched: 0,
    };
    for (const e of log) {
      const side = out[e.actor] || out.system;
      side.total++;
      let matched = false;
      for (const p of PATTERNS) {
        if (p.re.test(e.text)) {
          side[p.key]++;
          if (p.points) {
            const m = e.text.match(p.points);
            if (m) side.points += parseInt(m[1], 10) || 0;
          }
          matched = true;
          break;
        }
      }
      if (!matched) {
        side.other++;
        if (e.actor !== "system") out.unmatched++;
      }
    }

    // Aggression: committing units and taking battlefields is proactive;
    // passing focus is reactive.
    const aggr = (s) => s.commit + s.conquer * 2 + s.showdown;
    out.selfAggression = aggr(out.self);
    out.oppAggression = aggr(out.opponent);
    const ratio =
      out.oppAggression > 0
        ? out.selfAggression / out.oppAggression
        : out.selfAggression > 0
        ? Infinity
        : 1;
    out.ratio = ratio;

    const turns = Math.max(1, match.turns || out.self.endTurn || 1);
    out.passRate = out.self.passFocus / turns;

    if (!out.hasLog || out.self.total + out.opponent.total < 4) {
      out.verdict = "No read";
      out.detail =
        "Not enough of the game log was captured to judge playstyle.";
      return out;
    }

    if (ratio >= 1.5) out.verdict = "Aggressive";
    else if (ratio <= 0.67) out.verdict = "Passive";
    else if (out.passRate >= 1.2) out.verdict = "Reactive";
    else out.verdict = "Balanced";

    const s = out.self, o = out.opponent;
    const bits = [];
    bits.push(
      `You committed ${s.commit} unit${s.commit === 1 ? "" : "s"} to battlefields vs their ${o.commit}`
    );
    if (s.conquer || o.conquer)
      bits.push(`conquered ${s.conquer} vs their ${o.conquer}`);
    if (s.trash || o.trash)
      bits.push(`lost ${s.trash} card${s.trash === 1 ? "" : "s"} to trash vs their ${o.trash}`);
    let detail = bits.join(", ") + ".";

    // A short, honest coaching line.
    const won = match.result === "win";
    if (out.verdict === "Passive" && !won) {
      detail += " They out-committed you — contesting battlefields earlier is the obvious lever.";
    } else if (out.verdict === "Aggressive" && !won && s.trash > o.trash) {
      detail += " You pushed hard but lost the trades; picking better fights may matter more than more fights.";
    } else if (out.verdict === "Aggressive" && won) {
      detail += " Pressure paid off.";
    } else if (out.verdict === "Passive" && won) {
      detail += " You won while ceding tempo — efficient, but risky against faster decks.";
    } else if (out.verdict === "Reactive") {
      detail += ` You passed focus ${s.passFocus} times across ${turns} turns.`;
    }
    out.detail = detail;
    return out;
  }

  /* "Conquered Sunken Temple and scored 2." - the battlefield's name sits
   * between the verb and the score clause, and the row's actor bar says who
   * took it. The one reliable place battlefield names appear in a log. */
  const CONQUER_RE = /\bconquered\s+(.+?)(?:\s+and\s+scored\s+\d+)?\s*[.!?]?$/i;

  /**
   * Every conquest in a log, in order: [{ name, actor }]. Names come back as
   * the log printed them; system-attributed lines are kept with their actor so
   * the caller can decide, but the aggregator only counts self and opponent.
   */
  function conquests(log) {
    const out = [];
    for (const e of Array.isArray(log) ? log : []) {
      if (!e || typeof e.text !== "string") continue;
      const m = CONQUER_RE.exec(e.text);
      if (!m) continue;
      const name = m[1].trim();
      if (!name || name.length > 60) continue; // a clause, not a name
      out.push({ name, actor: e.actor || "system" });
    }
    return out;
  }

  root.RATrackerAnalysis = { analyse, conquests };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerAnalysis;
}
