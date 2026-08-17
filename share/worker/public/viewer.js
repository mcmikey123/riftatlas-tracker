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
    "RAShare",
    "RAShareHosts",
    "rehydrateCssAssets",
    "RAShareViewer",
    "RARepaint",
    "RAClipboard"
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
  let playback = null;
  let running = false;

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
    // be missing, so the engine failure is the one message stated twice.
    const { kind, message, retry } = root.RAShareViewer
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
  function rehydrate(payload) {
    const { ViewerError, unresolvedCssRefs, emptyCssTextCount } = root.RAShareViewer;
    const events = Array.isArray(payload.events) ? payload.events : [];
    if (events.length < 2) throw new ViewerError("format", "share carries no replayable events");

    // Keyed off the payload's own assets, never meta.cssRefs: the store's
    // hashes and the payload's keyspace can legitimately diverge.
    const assets = new Map(Object.entries(payload.assets || {}));

    const missing = unresolvedCssRefs(events, assets);
    if (missing.length) {
      throw new ViewerError("css", missing.length + " stylesheet refs have no asset");
    }

    const rehydrated = root.rehydrateCssAssets(events, assets);
    const empty = emptyCssTextCount(rehydrated);
    if (empty > 0) throw new ViewerError("css", empty + " stylesheets rehydrated empty");
    return rehydrated;
  }

  /** What this recording is, for the line under the title. */
  function summarise(meta, marks, total) {
    const bits = [];
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
      let broken = 0;
      try {
        const frame = ui.scale.querySelector("iframe");
        const inner = frame && frame.contentDocument;
        if (inner) broken = root.RAShareViewer.brokenImages(inner.images, CARD_ART_ORIGIN);
      } catch (err) {
        // Torn down, or an engine that will not hand over the replay document.
        // Either way there is nothing to report and nothing to retry.
      }
      if (broken > 0) {
        root.clearInterval(timer);
        notice("Card images couldn't load — the game's image server is unreachable. The rest of the replay is unaffected.");
      } else if (checks >= CARD_ART_CHECKS) {
        root.clearInterval(timer);
      }
    }, CARD_ART_INTERVAL_MS);
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
  function copyMoment(link, button) {
    const url = root.RAShareHosts.buildLink({
      endpoint: root.location.origin,
      objectId: link.objectId,
      keyBytes: link.keyBytes,
      atSeconds: root.RAShareHosts.toLinkSeconds(playback.getTime())
    });
    root.RAClipboard.copyToButton(url, button);
  }

  function mount(meta, events, link) {
    const { ViewerError, fmtClock } = root.RAShareViewer;
    const { MAX_CHIPS, SEEK, timeline, evenly, truncationText } = root.RAReplayTimeline;

    const marks = timeline(events);
    const chips = evenly(marks, MAX_CHIPS);

    if (meta.state === "truncated") notice(truncationText(meta, null, marks) + ".");
    if (meta.incomplete || meta.truncatedAtChunk != null) {
      notice("The tail of this recording was lost, so the replay ends before the match did.", true);
    }
    const chapterEls = renderChapters(chips);

    function paintTime(at, total) {
      ui.seek.max = String(Math.round(total));
      ui.seek.value = String(Math.round(at));
      ui.clock.textContent = fmtClock(at) + " / " + fmtClock(total);
      let active = -1;
      chips.forEach((chip, n) => {
        if (chip.ms <= at + 1) active = n;
      });
      chapterEls.forEach((b, n) => b.classList.toggle("on", n === active));
    }

    function paintPlayState(playing) {
      ui.play.textContent = playing ? "❚❚" : "▶";
      ui.play.setAttribute("aria-label", playing ? "Pause" : "Play");
    }

    // The stage has to be laid out before create(): the core fits the board to
    // stage.clientWidth/clientHeight, and a hidden stage measures zero, which
    // would leave the board pinned at 1:1 in the corner.
    ui.status.hidden = true;
    ui.player.hidden = false;

    playback = root.RAReplayCore.create({
      stage: ui.stage,
      scaleEl: ui.scale,
      events,
      meta,
      marks,
      autoplay: true,
      // A plain link plays on open; a link that names a moment opens paused at it,
      // because the sender is pointing at that moment and playing on walks off it.
      // The core makes that call - see shouldAutoplay - so both surfaces cannot
      // drift on it. null here means "no moment given"; 0 means second zero.
      startAtMs: root.RAShareHosts.fromLinkSeconds(link.atSeconds),
      onTime: paintTime,
      onPlayState: paintPlayState
    });
    if (!playback) {
      ui.player.hidden = true;
      throw new ViewerError("playback");
    }

    ui.sub.textContent = summarise(meta, marks, playback.totalTime);
    ui.play.addEventListener("click", () => playback.togglePlay());
    ui.copyAt.addEventListener("click", () => copyMoment(link, ui.copyAt));
    ui.prev.addEventListener("click", () => playback.stepTo(-1));
    ui.next.addEventListener("click", () => playback.stepTo(1));
    // Written back from what the core accepted, so the control never claims a
    // rate the engine is not running at. The options only offer valid speeds,
    // but the core owns the contract, not this markup.
    ui.speed.addEventListener("change", function () {
      ui.speed.value = String(playback.setSpeed(parseFloat(ui.speed.value)));
    });
    // `input` fires all the way through a drag, so the drag holds playback and
    // the end of the drag is what puts it back. The end is taken from the events
    // that always fire — never from `change`, which Gecko withholds when the
    // value lands back where the interaction started it, and this page is served
    // to whatever browser the link was opened in.
    ui.seek.addEventListener("input", () => playback.seek(parseInt(ui.seek.value, 10) || 0, SEEK.DRAG));
    for (const type of root.RAReplayCore.DRAG_END_EVENTS) ui.seek.addEventListener(type, playback.endDrag);
    ui.chapters.addEventListener("click", (e) => {
      const ms = e.target && e.target.dataset ? e.target.dataset.ms : undefined;
      if (ms !== undefined) playback.seek(parseInt(ms, 10) || 0, SEEK.CHAPTER);
    });
    // Fit once more after layout settles; the first fit runs inside create(),
    // before the chapter row has necessarily taken its final height.
    root.requestAnimationFrame(() => playback.refit());

    /* Anything appearing above the player steals height from the stage, and the
     * board keeps whatever scale it was fitted at — so it sits clipped until the
     * window happens to be resized. The card-art notice does exactly that, about
     * two seconds in. Same guard as the extension's modal: the callback writes only
     * a transform on a child, which changes no layout, so it cannot feed itself.
     * Nothing disconnects it because this page never tears the player down. */
    if (typeof root.ResizeObserver === "function") {
      new root.ResizeObserver(() => playback.refit()).observe(ui.stage);
    }

    watchCardArt();
  }

  function onKey(e) {
    if (!playback) return;
    // Text entry owns its keys and a focused button owns space. The rule itself
    // is `targetOwnsKey` in replay-timeline.js, shared with the extension's
    // modal: this page and that one had drifted on it four times, and a guard
    // that is right in one viewer and absent in the other is one bug shipped
    // twice.
    if (root.RAReplayTimeline.targetOwnsKey(e.target, e.key)) return;

    if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      playback.togglePlay();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      playback.stepTo(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      playback.stepTo(1);
    } else if (e.key === "Home") {
      e.preventDefault();
      playback.seek(0, root.RAReplayTimeline.SEEK.JUMP);
    } else if (e.key === "End") {
      e.preventDefault();
      playback.seek(playback.totalTime, root.RAReplayTimeline.SEEK.JUMP);
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
      const events = rehydrate(payload);

      try {
        mount((payload && payload.meta) || {}, events, link);
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
      "player", "play", "prev", "next", "seek", "clock", "speed", "copyAt", "chapters", "stage", "scale"]) {
      ui[id] = doc.getElementById(id);
    }

    // Reported before the download rather than after it: a viewer that cannot
    // play anything should say so immediately, not after 3.5 MB.
    const missing = REQUIRED.filter((name) => !root[name]);
    if (missing.length || !root.RAReplayCore.available()) {
      return failed(new Error("viewer modules missing: " + (missing.join(", ") || "rrweb Replayer")), "engine");
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
