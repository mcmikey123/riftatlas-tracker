/* Rift Atlas Stats Tracker - replay timeline helpers
 *
 * The arithmetic behind a replay's transport: which moments are settled board
 * states, how many of them a chip row can show, how far a truncated capture
 * actually got, what scale the board is drawn at, and whether a given seek
 * leaves the replay running — plus `stripInertLinks`, the one scrub the event
 * stream gets on its way into the engine.
 *
 * Pure by construction: no DOM, no escaping, no chrome APIs, no rrweb. Callers
 * escape whatever they interpolate into markup, so the same functions serve the
 * extension dashboard and the standalone share viewer.
 */
(function (root) {
  "use strict";

  const FULL_SNAPSHOT = 2; // rrweb EventType.FullSnapshot
  const CUSTOM = 5; // rrweb EventType.Custom
  const MAX_CHIPS = 30; // more than this and the chip row stops being scannable

  /**
   * Captures are ~1280x800, so on anything bigger than a laptop panel a replay
   * that refused to pass 1:1 would sit in one corner of the screen — which is
   * the complaint fullscreen exists to answer. Upscaling is therefore allowed,
   * capped at 2x: the board is DOM text that the compositor re-rasters at the
   * transform's scale, so it stays sharp, but past 2x there is no more detail
   * in the capture to reveal and the card art is only getting blurrier.
   */
  const MAX_SCALE = 2;
  /**
   * Scale is quantised to this step, and snapped to exactly 1 whenever it lands
   * within one step of it. 1:1 is the one ratio where every captured pixel maps
   * onto one device pixel with no resampling at all, so it is worth a percent
   * of unused room; the quantising itself stops a drag-resize from re-rastering
   * the iframe at a new fractional scale on every single frame.
   */
  const SCALE_STEP = 0.01;

  /** The scale to render at, given how much room the raw fit would allow. */
  function quantise(raw) {
    const capped = Math.min(raw, MAX_SCALE);
    if (Math.abs(capped - 1) < SCALE_STEP) return 1;
    // Floored, never rounded: a scale above the raw fit would overflow the stage.
    return Math.max(SCALE_STEP, Math.floor(capped / SCALE_STEP) * SCALE_STEP);
  }

  /**
   * Why the transport was moved. The reason is the whole input to the resume
   * policy below, so every caller that seeks names one.
   */
  const SEEK = Object.freeze({
    SCRUB: "scrub", // the drag is over: the slider was released or lost focus
    DRAG: "drag", // mid-drag, with more input events still coming
    CHAPTER: "chapter", // a chapter chip
    JUMP: "jump", // Home / End
    STEP: "step", // the step buttons and the arrow keys
  });

  /**
   * Whether a seek leaves the transport running. `playing` is the transport as
   * the viewer understands it, which is not always the engine's own state —
   * `seekOutcome` below is what works that out and the only caller that should
   * be answering this question directly.
   *
   * The rule is that seeking changes position, not play state: scrubbing to a
   * spot or jumping to a turn while the replay is playing carries on playing
   * from where it landed. Two reasons are exempt, both about intent rather than
   * mechanism:
   *   - STEP is a request to hold still and look at one board state;
   *   - DRAG is one of the dozens of `input` events a single drag fires, so it
   *     holds playback instead of restarting the engine on every pixel of
   *     travel; the SCRUB that ends the drag is what resumes.
   * Landing on the very end resumes nothing — there is nothing left to play, and
   * restarting from zero is togglePlay's job, only ever asked for explicitly.
   */
  function resumesAfterSeek(seek) {
    if (!seek || !seek.playing) return false;
    const reason = seek.reason || SEEK.SCRUB;
    if (reason === SEEK.STEP || reason === SEEK.DRAG) return false;
    const total = Number(seek.total);
    return !(Number.isFinite(total) && Number(seek.ms) >= total);
  }

  /**
   * Everything a seek does to the transport, as one table: whether it plays on
   * from where it landed, and what the drag latch becomes afterwards.
   *
   *   seekOutcome({ playing, held, finished, reason, ms, total }) -> { resume, held }
   *
   * The pair comes out of one call because the pair is the state machine. The
   * boolean was easy to extract on its own and the latch was left behind in the
   * rrweb-shaped code, updated in one branch and cleared in three others — and
   * the path that did neither was a bug that no unit test could reach.
   *
   * Two of the inputs are stops that are not really stops:
   *   - `held` says a drag began while the transport was running. Between the
   *     `input` events of one drag the engine really is stopped, so the drag and
   *     the release that ends it are the only two reasons allowed to read the
   *     latch; a latch left behind by a drag whose end went unseen therefore
   *     cannot make a chapter chip or a jump start playback on its own.
   *   - `finished` says the transport stopped because it ran out rather than
   *     because the viewer asked it to. Seeking back into the replay is then the
   *     same gesture as seeking during playback, so it plays on — a chapter chip
   *     clicked once the replay has ended is a natural thing to do.
   */
  function seekOutcome(state) {
    const s = state || {};
    const reason = s.reason || SEEK.SCRUB;
    const latched = !!s.held && (reason === SEEK.DRAG || reason === SEEK.SCRUB);
    const running = !!s.playing || !!s.finished || latched;
    return {
      resume: resumesAfterSeek({ playing: running, reason, ms: s.ms, total: s.total }),
      held: reason === SEEK.DRAG && running,
    };
  }

  /**
   * Where a replay opens, given the position a surface asked for and how long
   * the recording turned out to be.
   *
   * Clamped, never refused. The position most often comes from a share link's
   * timestamp field, and a link claiming 40:00 of a 31-minute replay is not a
   * broken link — it is a link to a moment the capture stopped short of, most
   * likely because the recorder ran out of budget before the match ended.
   * Landing on the last frame is a truthful answer to that; an error page in
   * place of a replay that downloaded and decrypted perfectly is not.
   *
   * Anything unreadable — absent, negative, not a number — opens at the start,
   * which is where a replay opens when nobody asks for anything.
   */
  function startPosition(requestedMs, totalMs) {
    const at = Number(requestedMs);
    if (!Number.isFinite(at) || at <= 0) return 0;
    const total = Number(totalMs);
    if (!Number.isFinite(total) || total <= 0) return 0;
    return Math.min(at, total);
  }

  /**
   * Whether a surface that asked to autoplay actually gets it. A replay that
   * starts moving on its own is motion the viewer did not ask for, which is the
   * one thing `prefers-reduced-motion` is a standing answer to — so the
   * preference wins, in the dashboard modal and in the share viewer alike, and
   * the play button is right there either way.
   *
   * `opensAtMoment` is true when the caller was told exactly where to start — a
   * share link carrying a timestamp. Those open paused: the point of sending one
   * is "look at this", and playing on from it walks off the thing being pointed
   * at before the recipient has seen it. Not the same as "starts at zero": a link
   * may deliberately name second 0, which is still a named moment.
   */
  function shouldAutoplay(requested, reducedMotion, opensAtMoment) {
    return !!requested && !reducedMotion && !opensAtMoment;
  }

  /**
   * Whether the element a keypress landed on owns that key itself, so the
   * transport must keep its hands off it.
   *
   * Both surfaces hang their shortcuts off a document-level keydown, and both
   * now have things inside the replay that swallow keys of their own: a
   * read-only field holding a share link, which is focused and selected the
   * moment the link appears, and the two buttons of the share disclosure. Left
   * unguarded, Home and End jump the replay instead of moving the caret, and
   * Space toggles playback instead of pressing the button under the finger -
   * on the only path to a consented upload.
   *
   * `target` is the event target; anything with `tagName`, `type` and
   * `isContentEditable` will do, which is what makes this testable without a DOM.
   *
   * The seek slider is the one input that does NOT own the arrows. Its native
   * nudge is one millisecond of a replay minutes long, where the transport's
   * arrows land on the next board state, and letting the range move itself
   * would start a drag that no pointer release ever ends.
   *
   * Lives here rather than in either surface because the two have drifted on
   * exactly this four times already, and a guard that is right in one viewer and
   * absent in the other is the same bug shipped twice.
   */
  function targetOwnsKey(target, key) {
    const tag = (target && target.tagName) || "";
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT" && target.type !== "range") return true;
    if (target && target.isContentEditable) return true;
    // A focused button owns space, and nothing else: space is how it is pressed.
    return tag === "BUTTON" && (key === " " || key === "Spacebar");
  }

  /** Turn number carried by an rrweb custom event, or null if it isn't one. */
  function turnOf(event) {
    if (!event || event.type !== CUSTOM || !event.data) return null;
    if (!/turn/i.test(String(event.data.tag || ""))) return null;
    const p = event.data.payload || {};
    const n = p.turnNumber != null ? p.turnNumber : p.turn;
    return Number.isFinite(Number(n)) ? Number(n) : null;
  }

  /**
   * Settled board states, as ms from the first event.
   *
   * Recorder-supplied `ra:turn` markers win, and in a recording made by this
   * extension there is always one per turn - `tagTurn` emits them independently
   * of whether a snapshot was spent.
   *
   * The fallback numbers full snapshots 1..N and labels them as turns, which is
   * a lie it has always told to some degree and now tells loudly: snapshots run
   * on a time cadence, so a 20-turn match yields roughly one a minute. It is
   * reached only when a recording carries no markers at all.
   */
  function timeline(events) {
    // No events, no board states. Both callers happen to guard on a minimum
    // length before they get here, but this is an exported pure helper and
    // reading events[0] out of an empty list is not its caller's problem.
    if (!events || !events.length) return [];
    const t0 = events[0].timestamp || 0;
    const marked = [];
    for (const e of events) {
      const turn = turnOf(e);
      if (turn !== null) marked.push({ ms: (e.timestamp || t0) - t0, turn });
    }
    if (marked.length) return marked;
    const frames = [];
    for (const e of events) {
      if (e && e.type === FULL_SNAPSHOT) {
        frames.push({ ms: (e.timestamp || t0) - t0, turn: frames.length + 1 });
      }
    }
    return frames;
  }

  /** At most `max` entries, evenly spaced, first and last always kept. */
  function evenly(marks, max) {
    if (marks.length <= max) return marks;
    const step = (marks.length - 1) / (max - 1);
    const out = [];
    for (let n = 0; n < max; n++) out.push(marks[Math.round(n * step)]);
    return out;
  }

  /** Banner copy for a capture that stopped before the match did. */
  function truncationText(meta, match, marks) {
    const last = marks.length ? marks[marks.length - 1].turn : null;
    const coveredTo = Number.isFinite(Number(meta.truncatedAtTurn)) ? Number(meta.truncatedAtTurn) : last;
    const turns = Number(match && match.turns);
    if (coveredTo == null) return "This replay stops before the end of the match.";
    const covered = `This replay covers turns 1–${coveredTo}`;
    return Number.isFinite(turns) && turns > coveredTo
      ? `${covered} of ${turns}; capture ran out of budget after that`
      : `${covered} of this match`;
  }

  /**
   * `rel` tokens that make a <link> pure overhead once it is replayed.
   *
   * The recorder captures `document.documentElement`, so the game's whole
   * <head> is serialised into every keyframe and re-mounted on every rebuild.
   * The nodes below then make the viewer go to the network for something no
   * viewer will ever see: the favicons are refused by the viewer's img-src
   * (which stays tight — a favicon nobody looks at is not worth reaching
   * play.riftatlas.com for), and the preloads are fetched and then warned about
   * because nothing consumes them, scripting being off inside rrweb's iframe.
   *
   * The list is exactly "reaches the network, renders nothing". `canonical`,
   * `author`, `alternate` and friends are left in: they cost a few bytes and no
   * requests, and shrinking the list is how this stays provably safe. Dropping
   * `alternate` in particular would be a bug waiting to happen — `rel="alternate
   * stylesheet"` is a stylesheet.
   *
   * Tokens, not whole `rel` strings, because `rel` is a space-separated list:
   * "shortcut icon" is the common spelling of a favicon.
   */
  const INERT_LINK_RELS = Object.freeze([
    "icon",
    "shortcut", // only ever seen as "shortcut icon"
    "apple-touch-icon",
    "apple-touch-icon-precomposed",
    "mask-icon",
    "manifest", // nothing is installable from a replay iframe
    "preload",
    "modulepreload",
    "prefetch",
    "preconnect",
    "dns-prefetch"
  ]);

  const INERT_LINK_REL_SET = new Set(INERT_LINK_RELS);

  /**
   * Whether this node is a <link> that can be removed without changing a pixel.
   *
   * Three conditions, and the first two exist because the failure mode of
   * getting this wrong is silent. `store/css-assets.js` swaps a stylesheet's
   * text for `attributes.__cssRef` and the viewer swaps it back to `_cssText`,
   * and the vendored rrweb turns a <link> into a <style> only when `_cssText`
   * is truthy — so a dropped stylesheet is not an error, it is a replay that
   * plays perfectly and completely unstyled.
   *
   *   - a node carrying `_cssText` or `__cssRef` is a stylesheet whatever its
   *     `rel` claims, and is never a candidate;
   *   - every token of `rel` must be inert, so "alternate stylesheet", or any
   *     future rel we have not thought about paired with one we have, keeps the
   *     node. A <link> with no `rel` at all has no token and is kept too.
   *
   * The set is an allowlist of things to drop rather than a denylist of things
   * to keep, which is the direction that fails safe: an unrecognised <link>
   * survives.
   */
  function isInertLink(node) {
    if (!node || typeof node !== "object") return false;
    if (String(node.tagName || "").toLowerCase() !== "link") return false;

    const attributes = node.attributes;
    if (!attributes || typeof attributes !== "object") return false;
    if (attributes._cssText !== undefined || attributes.__cssRef !== undefined) return false;

    const rel = typeof attributes.rel === "string" ? attributes.rel : "";
    const tokens = rel.toLowerCase().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => INERT_LINK_REL_SET.has(token));
  }

  /**
   * Rebuild a node tree without its inert <link> children, returning the
   * original node whenever nothing below it changed.
   *
   * Deliberately the same shape and the same reach as `mapNode`/`mapEvents` in
   * `store/css-assets.js` — full snapshots only, via `event.data.node` — rather
   * than a second, wider walker. Nodes added later by a mutation are therefore
   * out of reach here exactly as they are out of reach of CSS extraction: a
   * page that swaps its favicon at runtime still mounts that one <link>. It
   * costs one refused request instead of one per keyframe, and reaching into
   * mutation `adds` would mean deleting nodes a later `removes` still refers to.
   */
  function pruneNode(node) {
    if (!node || typeof node !== "object" || !Array.isArray(node.childNodes)) return node;

    let changed = false;
    const kept = [];
    for (const child of node.childNodes) {
      if (isInertLink(child)) {
        changed = true;
        continue;
      }
      const next = pruneNode(child);
      if (next !== child) changed = true;
      kept.push(next);
    }

    return changed ? Object.assign({}, node, { childNodes: kept }) : node;
  }

  /**
   * The event stream with every inert <link> removed from every full snapshot.
   *
   * Pure, and identity-preserving like `store/css-assets.js`: a stream with
   * nothing to strip comes back as the very same array, so replays of pages
   * without a decorated <head> pay nothing.
   */
  function stripInertLinks(events) {
    if (!Array.isArray(events)) return events;

    let changed = false;
    const next = events.map((event) => {
      const node = event && event.data && event.data.node;
      if (!node) return event;
      const nextNode = pruneNode(node);
      if (nextNode === node) return event;
      changed = true;
      const nextData = Object.assign({}, event.data, { node: nextNode });
      return Object.assign({}, event, { data: nextData });
    });

    return changed ? next : events;
  }

  // Same dual export as store/css-assets.js: a global for the browser, CommonJS
  // for `node --test`.
  const api = {
    FULL_SNAPSHOT,
    CUSTOM,
    MAX_CHIPS,
    MAX_SCALE,
    SCALE_STEP,
    SEEK,
    INERT_LINK_RELS,
    isInertLink,
    stripInertLinks,
    quantise,
    resumesAfterSeek,
    seekOutcome,
    startPosition,
    shouldAutoplay,
    targetOwnsKey,
    turnOf,
    timeline,
    evenly,
    truncationText,
  };

  root.RAReplayTimeline = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
