/* Rift Atlas Stats Tracker - share viewer
 *
 * The recipient's whole experience: read the key out of the URL fragment, fetch
 * the ciphertext from this same origin, decrypt it, put the stylesheets back,
 * and hand the events to the shared playback core.
 *
 *   /#1.<object-id>.<key>   ->   GET /b/<object-id>   ->   AES-GCM   ->   rrweb
 *
 * An optional fourth fragment field is a position in whole seconds, and the
 * replay opens there. "Copy link to this moment" is the other half of it.
 *
 * The fragment never leaves the browser, so the instance serving this page
 * cannot read what it is storing. It follows that everything here runs in the
 * client and that every failure has to be explained in the page itself.
 *
 * Kept deliberately small: browser and network code gets no unit tests by
 * project convention, so anything decidable from data alone lives in
 * share/viewer-support.js, which does.
 */
(function (root) {
  "use strict";

  const doc = root.document;

  // The game's card art. Everything else the replay needs is same-origin or a
  // data: URI; this is the one host that can be down on its own.
  const CARD_ART_ORIGIN = "https://assets.riftatlas-workers.com";
  const CARD_ART_INTERVAL_MS = 2000;
  const CARD_ART_CHECKS = 8;

  // Globals the synced modules install. A missing file here means sync-assets.sh
  // did not run or did not copy everything, and the page can do nothing at all.
  const REQUIRED = [
    "rrwebReplay",
    "RAReplayTimeline",
    "RAReplayCore",
    "RAReplayTransport",
    "RAShare",
    "RAShareHosts",
    "rehydrateCssAssets",
    "RAShareViewer",
    "RARepaint",
    "RAClipboard"
  ];

  /* A global can be present and still be the wrong vintage. public/replay/,
   * public/share/ and public/store/ are gitignored duplicates that
   * sync-assets.sh refreshes from the repo before every deploy, so a deploy
   * that skipped that step serves this file beside modules older than it - the
   * globals all exist and REQUIRED above is satisfied.
   *
   * Every member this page reaches for, and the list is complete because
   * viewer-assets.test.js scrapes this file and fails if it is not: a member
   * used here and missing below is one more way to reach the failure this
   * check exists to prevent. Without it the first stale member throws part-way
   * through start(), after the elements are looked up but before the retry
   * button and the key handler are wired, and the page simply stops - no
   * message, no retry, indistinguishable from a hang. That is the failure
   * sync-assets.sh warns about and the one nobody is watching for. */
  const REQUIRED_MEMBERS = [
    ["RAClipboard", "copyToButton"],
    ["RARepaint", "repaint"],
    ["RAReplayCore", "available"],
    ["RAReplayCore", "create"],
    ["RAReplayTimeline", "MAX_CHIPS"],
    ["RAReplayTimeline", "SEEK"],
    ["RAReplayTimeline", "SPEEDS"],
    ["RAReplayTimeline", "evenly"],
    ["RAReplayTimeline", "targetOwnsKey"],
    ["RAReplayTimeline", "timeline"],
    ["RAReplayTimeline", "truncationText"],
    ["RAReplayTransport", "handleKey"],
    ["RAReplayTransport", "wireTransport"],
    ["RAShare", "importKey"],
    ["RAShare", "parseSharePayload"],
    ["RAShareHosts", "buildLink"],
    ["RAShareHosts", "fromLinkSeconds"],
    ["RAShareHosts", "parseLinkGame"],
    ["RAShareHosts", "fromLinkSpeed"],
    ["RAShareHosts", "parseLink"],
    ["RAShareHosts", "toLinkSeconds"],
    ["RAShareViewer", "ViewerError"],
    ["RAShareViewer", "cardArtHealth"],
    ["RAShareViewer", "cardArtUnreachable"],
    ["RAShareViewer", "classify"],
    ["RAShareViewer", "describeFailure"],
    ["RAShareViewer", "emptyCssTextCount"],
    ["RAShareViewer", "fmtClock"],
    ["RAShareViewer", "unresolvedCssRefs"]
  ];

  // Secondary lines. The headline says what happened; these say what to do,
  // which is the only reason the failures are told apart at all.
  const DETAILS = {
    link: "Check that the whole link was copied, including everything after the # sign.",
    missing: "Shares are deleted seven days after they are created.",
    network: "Check your connection, then try again.",
    server: "Nothing is wrong with your link. Try again in a moment.",
    key: "The part of the link after the # sign carries the key that decrypts it.",
    format: "What the server returned is not a Rift Atlas replay.",
    css: "It arrived, but the stylesheets it needs did not, so the board cannot be drawn as it was.",
    engine: "Reload the page. If it keeps happening, this viewer is missing part of itself.",
    playback: "It downloaded and decrypted, but the replay engine would not accept it.",
    unknown: "Reload the page and try again."
  };

  const ui = {};
  let playback = null; // the stable facade wireTransport is bound to
  let running = false;

  /* The games this share carries - one for an ordinary share - and which is
   * mounted. A series payload holds several; the page keeps ONE playback core
   * alive and switching game tears the old core down and mounts the next
   * through the same controls. The transport is wired once, to a facade that
   * forwards to the current core, because wiring it per game would stack a
   * listener per switch, each closed over a core already destroyed. */
  let games = [];
  let seriesInfo = null;
  let currentGame = -1;
  let shareLink = null;
  let chapterChips = [];
  let transportCallbacks = null; // {onTime, onPlayState}, captured at first wire

  /** Let the browser paint before a step that blocks the thread for ~300 ms. */
  function repaint() {
    return root.RARepaint.repaint(root);
  }

  function working(message) {
    ui.status.hidden = false;
    ui.status.classList.remove("failed");
    ui.bar.hidden = false;
    ui.retry.hidden = true;
    ui.statusMsg.textContent = message;
    ui.statusDetail.textContent = "";
  }

  function failed(err, fallbackKind) {
    // The module that knows the messages is itself one of the things that can
    // be missing, so the engine failure is the one message stated twice. The
    // member is checked, not just the global: a stale share/viewer-support.js
    // publishes RAShareViewer without describeFailure, and this is the one
    // function that cannot throw on the way to reporting that - it is the
    // reporting.
    // Written without `!!` on purpose: namespace-contract.test.js cannot read a
    // namespace through it, and would quietly stop checking RAShareViewer's
    // members here rather than fail. A plain `&&` keeps the reference legible
    // to it; the ternary below wants truthiness, not a boolean.
    const canDescribe =
      root.RAShareViewer && typeof root.RAShareViewer.describeFailure === "function";
    const { kind, message, retry } = canDescribe
      ? root.RAShareViewer.describeFailure(err, fallbackKind)
      : { kind: "engine", message: "The replay engine failed to load.", retry: false };
    console.warn("[RA-Tracker] share viewer failed (" + kind + "):", err);
    ui.player.hidden = true;
    ui.status.hidden = false;
    ui.status.classList.add("failed");
    ui.bar.hidden = true;
    ui.statusMsg.textContent = message;
    ui.statusDetail.textContent = DETAILS[kind] || "";
    ui.retry.hidden = !retry;
  }

  function notice(text, quiet) {
    const p = doc.createElement("p");
    p.className = quiet ? "notice notice-quiet" : "notice";
    p.textContent = text;
    ui.notices.appendChild(p);
  }

  async function download(objectId) {
    working("Downloading the replay…");
    let res;
    try {
      res = await root.fetch("/b/" + encodeURIComponent(objectId));
    } catch (cause) {
      throw new root.RAShareViewer.ViewerError("network", "fetch rejected: " + cause);
    }
    if (res.status === 404) throw new root.RAShareViewer.ViewerError("missing");
    if (!res.ok) throw new root.RAShareViewer.ViewerError("server", "server returned " + res.status);
    try {
      return new Uint8Array(await res.arrayBuffer());
    } catch (cause) {
      throw new root.RAShareViewer.ViewerError("network", "download interrupted: " + cause);
    }
  }

  async function decrypt(bytes, keyBytes) {
    const { ViewerError, classify } = root.RAShareViewer;
    working("Decrypting…");
    await repaint();
    try {
      const key = await root.RAShare.importKey(keyBytes, {});
      // Empty deps: platform WebCrypto and DecompressionStream.
      return await root.RAShare.parseSharePayload(bytes, key, {});
    } catch (err) {
      // Nothing gets past the GCM tag without the right key, so anything the
      // frame parser did not name is authentic garbage — a bad file, not a bad
      // key. `format` is therefore the right fallback, never `key`.
      throw new ViewerError(classify(err, "format"), String((err && err.message) || err));
    }
  }

  /**
   * Put the stylesheets back, and refuse to render if any of them are missing.
   *
   * This is the one step that fails silently if it is got wrong.
   * `rehydrateCssAssets` needs a Map: handed the plain object JSON produced, it
   * throws nothing and resolves every ref to "". The vendored rrweb only
   * promotes a <link> to a <style> when `_cssText` is truthy, so an empty string
   * leaves a <link> with no href behind and the board renders completely
   * unstyled — no exception, no console error, just an ugly-looking replay.
   * Both halves of that are checked rather than trusted.
   */
  function rehydrate(rawEvents, assets) {
    const { ViewerError, unresolvedCssRefs, emptyCssTextCount } = root.RAShareViewer;
    const events = Array.isArray(rawEvents) ? rawEvents : [];
    if (events.length < 2) throw new ViewerError("format", "share carries no replayable events");

    const missing = unresolvedCssRefs(events, assets);
    if (missing.length) {
      throw new ViewerError("css", missing.length + " stylesheet refs have no asset");
    }

    const rehydrated = root.rehydrateCssAssets(events, assets);
    const empty = emptyCssTextCount(rehydrated);
    if (empty > 0) throw new ViewerError("css", empty + " stylesheets rehydrated empty");
    return rehydrated;
  }

  /**
   * The payload as a list of playable games, whatever shape it arrived in:
   * `{ meta, events, assets }` is one game, `{ series, games: [...], assets }`
   * is several sharing one asset pool. Every game is rehydrated and validated
   * up front, so a series whose third game is broken fails here, honestly,
   * rather than when its chip is clicked.
   *
   * Assets are keyed off the payload's own map, never meta.cssRefs: the
   * store's hashes and the payload's keyspace can legitimately diverge.
   */
  function gamesOf(payload) {
    const assets = new Map(Object.entries((payload && payload.assets) || {}));
    if (payload && Array.isArray(payload.games) && payload.games.length) {
      seriesInfo = payload.series || {};
      return payload.games.map(function (g, i) {
        return {
          label: String((g && g.label) || "Game " + (i + 1)).slice(0, 24),
          result: g && (g.result === "win" || g.result === "loss") ? g.result : null,
          meta: (g && g.meta) || {},
          events: rehydrate(g && g.events, assets)
        };
      });
    }
    return [
      {
        label: null,
        result: null,
        meta: (payload && payload.meta) || {},
        events: rehydrate(payload && payload.events, assets)
      }
    ];
  }

  /** What this recording is, for the line under the title. */
  function summarise(game, marks, total) {
    const meta = game.meta;
    const bits = [];
    if (games.length > 1) {
      const opp = seriesInfo && seriesInfo.opponentName;
      bits.push(
        (seriesInfo && seriesInfo.format ? String(seriesInfo.format).toUpperCase() + " series" : "Series") +
          (opp ? " vs " + opp : "")
      );
      bits.push(game.label + (game.result ? " · " + game.result : ""));
    }
    const started = Number(meta.startedAt);
    if (Number.isFinite(started) && started > 0) bits.push(new Date(started).toLocaleString());
    if (marks.length) bits.push(marks.length + (marks.length === 1 ? " board state" : " board states"));
    bits.push(root.RAShareViewer.fmtClock(total));
    bits.push("anyone with this link can watch it");
    return bits.join(" · ");
  }

  function renderChapters(chips) {
    // One chip is the start of the replay and seeks nowhere useful.
    if (chips.length < 2) return [];
    const buttons = chips.map((chip) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "btn chapter";
      b.dataset.ms = String(chip.ms);
      b.textContent = "T" + chip.turn;
      b.title = "Jump to turn " + chip.turn;
      ui.chapters.appendChild(b);
      return b;
    });
    ui.chapters.hidden = false;
    return buttons;
  }

  function clearChildren(el) {
    if (el) el.textContent = "";
  }

  /**
   * The sharer's flags, read-only: chips that seek, and dots on the seek
   * track. They arrived in the game's meta, put there when the share was
   * built - this page cannot add or remove one, only visit them. The chips'
   * click listener is wired once in wireOnce, not here, so a series that
   * renders this per game does not stack one listener per switch.
   */
  function renderFlags(flags, totalMs) {
    const list = (Array.isArray(flags) ? flags : [])
      .map(function (f) {
        return f && Number.isFinite(Number(f.ms))
          ? { ms: Math.max(0, Math.round(Number(f.ms))), text: String(f.text || "").slice(0, 80) }
          : null;
      })
      .filter(Boolean)
      .sort(function (a, b) {
        return a.ms - b.ms;
      });
    if (!list.length) return;

    for (const f of list) {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "btn chapter flag";
      b.dataset.ms = String(f.ms);
      b.textContent = "⚑ " + root.RAShareViewer.fmtClock(f.ms) + (f.text ? " · " + f.text : "");
      b.title = "Jump to a moment the sharer flagged";
      ui.flags.appendChild(b);
    }
    ui.flags.hidden = false;

    if (ui.flagmarks && totalMs > 0) {
      ui.flagmarks.innerHTML = list
        .map(function (f) {
          return '<span class="flagdot" style="left:' + Math.min(100, (f.ms / totalMs) * 100).toFixed(2) + '%"></span>';
        })
        .join("");
    }
  }

  /** The series' game switcher: one chip per game, drawn once per page. */
  function renderGameChips() {
    if (games.length < 2) return;
    games.forEach(function (g, i) {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "btn chapter game";
      b.dataset.game = String(i);
      b.textContent = g.label + (g.result ? " · " + g.result : "");
      b.title = "Watch " + g.label;
      ui.games.appendChild(b);
    });
    ui.games.hidden = false;
  }

  function paintGameChips() {
    ui.games.querySelectorAll("[data-game]").forEach(function (b) {
      b.classList.toggle("on", Number(b.dataset.game) === currentGame);
    });
  }

  /**
   * Card art is fetched by the replay itself from another origin, so it can
   * fail on its own while everything else works. Polled rather than listened
   * for: rrweb reopens the replay document on every full-snapshot rebuild,
   * which drops any listener registered on it.
   */
  function watchCardArt() {
    let checks = 0;
    const timer = root.setInterval(() => {
      checks += 1;
      let health = null;
      try {
        const frame = ui.scale.querySelector("iframe");
        const inner = frame && frame.contentDocument;
        if (inner) health = root.RAShareViewer.cardArtHealth(inner.images, CARD_ART_ORIGIN);
      } catch (err) {
        // Torn down, or an engine that will not hand over the replay document.
        // Either way there is nothing to report and nothing to retry.
      }

      /* Judged only on the last look, never on the first one that sees a
       * failure.
       *
       * This used to fire the moment a single image from the host finished
       * empty, then clearInterval and never look again - so one card whose art
       * 404s, on a board where every other card is on screen, latched "the
       * game's image server is unreachable" for the whole replay and could not
       * be revised by the next poll that saw sixty images arrive. Waiting for
       * the last check costs the banner up to sixteen seconds and buys the only
       * evidence that distinguishes a dead host from a missing file: whether
       * anything from that host arrived at all.
       *
       * The srcs are logged either way. A partial failure says nothing in the
       * page - the reader can see the gap and the rest of the replay really is
       * unaffected - but it is the thing someone will want to look up. */
      if (checks < CARD_ART_CHECKS) return;
      root.clearInterval(timer);
      if (!health || health.broken === 0) return;
      console.warn(
        "[RA-Tracker] card art: " + health.loaded + " loaded, " + health.broken + " empty:",
        health.brokenSrc
      );
      if (root.RAShareViewer.cardArtUnreachable(health)) {
        notice("Card images couldn't load — the game's image server is unreachable. The rest of the replay is unaffected.");
      }
    }, CARD_ART_INTERVAL_MS);
  }

  /* ---- fullscreen ---------------------------------------------------------
   *
   * The dashboard's modal has had this since the replay viewer existed; this
   * page did not, so a recipient sent a board captured at 1920px read it in
   * whatever width the page's column happened to leave over.
   *
   * `.viewer` is what goes fullscreen rather than `.stage`, so the transport,
   * the chapter chips and the notices travel with the board - the same call the
   * modal makes when it fullscreens the shell instead of the body.
   *
   * Escape needs none of the modal's grace period here. There, one Escape could
   * both leave fullscreen and close the modal behind it, so the second meaning
   * had to be suppressed; this page has nothing behind the replay to close, and
   * binds no Escape at all, so the browser's own handling is the whole story.
   */
  let canFullscreen = false;

  function isFull() {
    return doc.fullscreenElement === ui.viewer;
  }

  function paintFullscreen() {
    const on = isFull();
    ui.viewer.classList.toggle("full", on);
    ui.full.textContent = on ? "⤢ Exit fullscreen" : "⛶ Fullscreen";
    ui.full.title = on ? "Leave fullscreen (f or Esc)" : "Fullscreen (f)";
    ui.full.setAttribute("aria-pressed", on ? "true" : "false");
  }

  /** Leave fullscreen if we are in it. Never throws, never rejects outward. */
  function leaveFullscreen() {
    let done;
    try {
      done = doc.exitFullscreen();
    } catch (err) {
      console.warn("[RA-Tracker] could not leave fullscreen:", err);
      return;
    }
    if (done && typeof done.catch === "function") {
      done.catch((err) => console.warn("[RA-Tracker] could not leave fullscreen:", err));
    }
  }

  /**
   * requestFullscreen can be refused outright - a user gesture the browser did
   * not credit, an embedding that withholds the permission - and it reports
   * that by rejecting rather than throwing. Either way the page stays exactly
   * as it was, so all that is owed is repainting the button to its real state.
   */
  function toggleFullscreen() {
    if (!canFullscreen) return;
    if (isFull()) return leaveFullscreen();
    let done;
    try {
      done = ui.viewer.requestFullscreen();
    } catch (err) {
      console.warn("[RA-Tracker] fullscreen was refused:", err);
      paintFullscreen();
      return;
    }
    if (done && typeof done.catch === "function") {
      done.catch((err) => {
        console.warn("[RA-Tracker] fullscreen was refused:", err);
        paintFullscreen();
      });
    }
  }

  function onFullscreenChange() {
    paintFullscreen();
    // The stage's new box is not final on this event in every engine, so fit
    // once now and again once layout has settled. The ResizeObserver mount()
    // installs covers this too; this is the belt to its braces, and matters on
    // the way out of fullscreen, where the observer can fire before the page
    // has taken its column width back.
    if (!playback) return;
    playback.refit();
    root.requestAnimationFrame(playback.refit);
  }

  /**
   * A link to this same share, opening wherever the replay is right now.
   *
   * The endpoint is this page's own origin, which is the whole point of the
   * Worker serving both the viewer and the object: the link a recipient
   * forwards is the link they were given, pointing at the instance that
   * actually holds the bytes.
   *
   * The address bar is deliberately left alone. Rewriting location.hash as
   * playback advanced would push a history entry every few seconds and turn
   * Back into "one second earlier"; this button is the explicit gesture
   * instead.
   */
  function copyMoment(button) {
    /* The rate is read off the control rather than the core, because the
     * control is where the transport writes back whatever the core accepted -
     * so it is the one place that cannot disagree with what is actually
     * playing. buildLink drops it when it is 1x, which is why an ordinary
     * link is still the ordinary link. The game is named only when there is
     * more than one to name. */
    const url = root.RAShareHosts.buildLink({
      endpoint: root.location.origin,
      objectId: shareLink.objectId,
      keyBytes: shareLink.keyBytes,
      atSeconds: root.RAShareHosts.toLinkSeconds(playback.getTime()),
      atSpeed: parseFloat(ui.speed.value),
      atGame: games.length > 1 ? currentGame + 1 : null
    });
    root.RAClipboard.copyToButton(url, button);
  }

  /* ---- one transport, several games --------------------------------------
   *
   * wireTransport binds the controls ONCE, and its listeners close over the
   * playback object create() handed back. Rebinding per game would stack a
   * listener per switch, each closed over a core already destroyed - so what
   * create() hands back is this facade, and switching game swaps the core
   * BEHIND it. The chip arrays are mutated in place for the same reason: the
   * transport's paint closed over them at wire time.
   */
  let core = null; // the live RAReplayCore controller for the mounted game
  const chapterEls = [];
  const facade = {
    get totalTime() {
      return core ? core.totalTime : 0;
    },
    getTime: () => (core ? core.getTime() : 0),
    isPlaying: () => !!(core && core.isPlaying()),
    seek: (ms, reason) => core && core.seek(ms, reason),
    endDrag: () => core && core.endDrag(),
    play: () => core && core.play(),
    pause: () => core && core.pause(),
    togglePlay: () => core && core.togglePlay(),
    stepTo: (dir) => core && core.stepTo(dir),
    setSpeed: (v) => (core ? core.setSpeed(v) : 1),
    refit: () => core && core.refit()
  };

  /**
   * Mount one game into the stage: the per-game chrome - chapters, flags,
   * notices, the sub line - and a fresh core wired to the transport's own
   * painters. Returns the core, or null when the recording will not play.
   *
   * `startAtMs` is non-null only on the first mount of the game a timestamped
   * link named; a chip click passes null and the game opens at its start.
   */
  function createCoreFor(index, startAtMs) {
    const { MAX_CHIPS, timeline, evenly, truncationText } = root.RAReplayTimeline;
    const g = games[index];

    clearChildren(ui.chapters);
    ui.chapters.hidden = true;
    clearChildren(ui.flags);
    ui.flags.hidden = true;
    if (ui.flagmarks) ui.flagmarks.innerHTML = "";
    clearChildren(ui.notices);
    currentGame = index;
    paintGameChips();

    const marks = timeline(g.events);
    const chips = evenly(marks, MAX_CHIPS);
    chapterChips.length = 0;
    Array.prototype.push.apply(chapterChips, chips);
    const els = renderChapters(chips);
    chapterEls.length = 0;
    Array.prototype.push.apply(chapterEls, els);

    if (g.meta.state === "truncated") notice(truncationText(g.meta, null, marks) + ".");
    if (g.meta.incomplete || g.meta.truncatedAtChunk != null) {
      notice("The tail of this recording was lost, so the replay ends before the match did.", true);
    }

    // The stage has to be laid out before create(): the core fits the board to
    // stage.clientWidth/clientHeight, and a hidden stage measures zero, which
    // would leave the board pinned at 1:1 in the corner.
    ui.status.hidden = true;
    ui.player.hidden = false;

    const fresh = root.RAReplayCore.create({
      stage: ui.stage,
      scaleEl: ui.scale,
      events: g.events,
      meta: g.meta,
      marks,
      autoplay: true,
      // Every link plays on open here, the one naming a moment included: a
      // recipient opening a link someone sent them is starting to watch, and
      // a frozen board with a play button is a worse answer to "look at this"
      // than the moment playing out. The core owns the rule either way - see
      // shouldAutoplay - and prefers-reduced-motion still overrides.
      playFromMoment: true,
      // null here means "no moment given"; 0 means second zero.
      startAtMs: startAtMs,
      onTime: transportCallbacks.onTime,
      onPlayState: transportCallbacks.onPlayState
    });
    if (!fresh) return null;

    ui.sub.textContent = summarise(g, marks, fresh.totalTime);
    renderFlags(g.meta.flags, fresh.totalTime);
    // Fit once more after layout settles; the first fit runs inside create(),
    // before the chapter and flag rows have taken their final height.
    root.requestAnimationFrame(function () {
      facade.refit();
    });
    watchCardArt();
    return fresh;
  }

  /** Switch the mounted game. A chip click, or the link's own g-field. */
  function showGame(index) {
    const i = Math.min(Math.max(0, index), games.length - 1);
    if (i === currentGame) return;
    if (core) {
      core.pause();
      core.destroy();
    }
    core = createCoreFor(i, null);
    if (!core) {
      ui.player.hidden = true;
      failed(new root.RAShareViewer.ViewerError("playback"));
      return;
    }
    // The rate the viewer chose is a property of their review, not of one
    // game, so the fresh core inherits it - written back from what the core
    // accepted, the same rule the transport's own change handler follows.
    ui.speed.value = String(core.setSpeed(parseFloat(ui.speed.value)));
  }

  function mount(link) {
    const { ViewerError } = root.RAShareViewer;

    // The transport row - the clock, the chips' highlight, play, step, seek and
    // the keys - is the same row the extension's modal draws, and lives in
    // replay/replay-transport.js so the two cannot drift on it. This page
    // keeps only what is its own: the game switcher, the flags, the copy-link
    // button and the notices.
    const first = link.atGame ? Math.min(Math.max(0, link.atGame - 1), games.length - 1) : 0;
    playback = root.RAReplayTransport.wireTransport({
      chips: chapterChips,
      fmtClock: root.RAShareViewer.fmtClock,
      els: {
        play: ui.play,
        prev: ui.prev,
        next: ui.next,
        slider: ui.seek,
        clock: ui.clock,
        speed: ui.speed,
        chapterEls,
        chapterHost: ui.chapters
      },
      create: (callbacks) => {
        transportCallbacks = callbacks;
        core = createCoreFor(first, root.RAShareHosts.fromLinkSeconds(link.atSeconds));
        return core ? facade : null;
      }
    });
    if (!playback) {
      ui.player.hidden = true;
      throw new ViewerError("playback");
    }

    /* A link that names a rate opens at it. Applied after wireTransport rather
     * than through create(), because the select has to be moved with it: the
     * transport writes that control back from what the core ACCEPTED, and a
     * replay running at 2x under a select still reading 1x is the control
     * lying about the replay. Same write-back rule as the change handler, for
     * the same reason. A link naming no rate leaves both alone. */
    const linkSpeed = root.RAShareHosts.fromLinkSpeed(link.atSpeed);
    if (linkSpeed !== null) ui.speed.value = String(playback.setSpeed(linkSpeed));

    ui.copyAt.addEventListener("click", () => copyMoment(ui.copyAt));
    // The flag chips carry data-ms like the chapters do, but live in their own
    // row, outside the transport's chapterHost - so their seek is wired here,
    // once, against the facade.
    ui.flags.addEventListener("click", (e) => {
      const ms = e.target && e.target.dataset ? e.target.dataset.ms : undefined;
      if (ms !== undefined) playback.seek(parseInt(ms, 10) || 0, root.RAReplayTimeline.SEEK.CHAPTER);
    });
    ui.games.addEventListener("click", (e) => {
      const i = e.target && e.target.dataset ? e.target.dataset.game : undefined;
      if (i !== undefined) showGame(Number(i));
    });

    /* Anything appearing above the player steals height from the stage, and the
     * board keeps whatever scale it was fitted at — so it sits clipped until the
     * window happens to be resized. The card-art notice does exactly that, about
     * two seconds in. Same guard as the extension's modal: the callback writes only
     * a transform on a child, which changes no layout, so it cannot feed itself.
     * Nothing disconnects it because this page never tears the player down. */
    if (typeof root.ResizeObserver === "function") {
      new root.ResizeObserver(() => facade.refit()).observe(ui.stage);
    }
  }

  /* Every transport key this page answers is one the extension's modal answers
   * the same way, so the map and the guard that goes with it are both in
   * replay/replay-transport.js. `f` is the one key this page adds around that
   * call, and it is added the way the modal adds it: only once the transport
   * has declined the event, and only when the focused element does not own the
   * key itself - `targetOwnsKey` is what keeps `f` from being swallowed while
   * someone is typing into a field. The modal also adds Escape; this page has
   * nothing behind the replay for Escape to close, so it binds none. */
  function onKey(e) {
    if (root.RAReplayTransport.handleKey(e, playback)) return;
    if (root.RAReplayTimeline.targetOwnsKey(e.target, e.key)) return;
    /* Bare f only. Ctrl+F and Cmd+F are Find, and preventDefault on those is
     * honoured, so an unguarded test here would swallow the browser's own
     * shortcut and go fullscreen instead. Guarded on this branch rather than at
     * the top of the handler: the keys above are the shared transport's, and
     * filtering them here would make this page answer them differently from the
     * dashboard's modal, which is the drift replay-transport.js exists to stop. */
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      toggleFullscreen();
    }
  }

  async function run() {
    if (running || playback) return;
    running = true;
    try {
      working("Opening the replay…");

      let link;
      try {
        link = root.RAShareHosts.parseLink(root.location.href);
      } catch (err) {
        throw new root.RAShareViewer.ViewerError("link", String((err && err.message) || err));
      }

      const bytes = await download(link.objectId);
      const payload = await decrypt(bytes, link.keyBytes);

      working("Rebuilding the board…");
      await repaint();

      try {
        games = gamesOf(payload);
        shareLink = link;
        renderGameChips();
        mount(link);
      } catch (err) {
        // Everything from here down is the engine refusing the recording, which
        // is one remedy — reading it — not the generic "something went wrong".
        const { ViewerError, classify } = root.RAShareViewer;
        throw new ViewerError(classify(err, "playback"), String((err && err.message) || err));
      }
    } catch (err) {
      failed(err);
    } finally {
      running = false;
    }
  }

  function start() {
    for (const id of ["sub", "notices", "status", "bar", "statusMsg", "statusDetail", "retry",
      "player", "play", "prev", "next", "seek", "clock", "speed", "full", "copyAt", "chapters",
      "flags", "flagmarks", "games", "stage", "scale"]) {
      ui[id] = doc.getElementById(id);
    }
    // The one element addressed by class: it is the page's layout root, and the
    // element fullscreen is requested on.
    ui.viewer = doc.querySelector(".viewer");

    /* Three checks, in this order, and the order is the point.
     *
     * Reported before the download rather than after it: a viewer that cannot
     * play anything should say so immediately, not after 3.5 MB.
     *
     * Globals first, because a member check on an absent global throws. Members
     * second, because the engine check below is itself a member call -
     * RAReplayCore.available - and a stale replay-core.js that does not publish
     * it would throw there, part-way through start(), which is the silent blank
     * page this whole guard exists to replace. Only once both hold is it safe
     * to ask the engine whether it can actually play.
     *
     * Both stale cases report `engine`: a half-updated deploy is the same
     * problem for the recipient as a missing file, and the same remedy for
     * whoever deployed it - run sync-assets.sh, deploy again.
     */
    const missing = REQUIRED.filter((name) => !root[name]);
    if (missing.length) {
      return failed(new Error("viewer modules missing: " + missing.join(", ")), "engine");
    }

    const stale = REQUIRED_MEMBERS
      .filter(([name, member]) => root[name][member] === undefined)
      .map(([name, member]) => name + "." + member);
    if (stale.length) {
      return failed(new Error("viewer modules are out of date, missing: " + stale.join(", ")), "engine");
    }

    if (!root.RAReplayCore.available()) {
      return failed(new Error("viewer modules missing: rrweb Replayer"), "engine");
    }

    /* The speed options are built from the shared list rather than written into
     * index.html, for the same reason the dashboard's modal builds its own:
     * this page and that one have to agree on what speeds exist, and a list
     * spelled out in two files is a list that eventually is not the same list.
     * Built after the module guard above, so a page missing replay-timeline.js
     * reports that rather than throwing here. */
    ui.speed.innerHTML = root.RAReplayTimeline.SPEEDS.map(
      (s) => `<option value="${s}"${s === 1 ? " selected" : ""}>${s}×</option>`
    ).join("");

    /* Feature-detected rather than assumed: an iframe embed without the
     * allow-fullscreen permission reaches this line with the method present and
     * `fullscreenEnabled` false, and a button that silently does nothing is
     * worse than no button. Nothing is ever torn down - this page does not
     * unmount its player - so the listener has no removal to match it. */
    canFullscreen =
      !!ui.full &&
      !!ui.viewer &&
      typeof ui.viewer.requestFullscreen === "function" &&
      typeof doc.exitFullscreen === "function" &&
      doc.fullscreenEnabled !== false;
    if (canFullscreen) {
      ui.full.addEventListener("click", toggleFullscreen);
      doc.addEventListener("fullscreenchange", onFullscreenChange);
      paintFullscreen();
    } else if (ui.full) {
      ui.full.hidden = true;
    }

    ui.retry.addEventListener("click", run);
    doc.addEventListener("keydown", onKey);
    run();
  }

  // Deferred scripts run after parsing, so the document is ready; the guard is
  // for anyone who moves this tag.
  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(typeof window !== "undefined" ? window : globalThis);
