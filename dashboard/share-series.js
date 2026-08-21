/* Rift Atlas Stats Tracker - sharing a whole series as one link
 *
 * One link for a best-of-three: every recorded game of the series in a single
 * encrypted object, played back through the same viewer with a game switcher.
 * Reuses the single-match pipeline's parts - the CSS strip, the frame, the
 * upload, the verification, the endpoint - and differs only in the payload:
 * `{ series, games: [...], assets }`, with the stylesheet assets pooled across
 * games because two games on one site share almost all of them.
 *
 * The flow is dialog-shaped rather than panel-shaped: a series row has no
 * share panel to paint phases into, and growing one for a flow that runs once
 * per series would be a lot of chrome for a toast's worth of progress. So the
 * disclosure is a dialog, the progress is a toast, and the link arrives in a
 * dialog with its own Copy button - the same read-only-field-and-button ending
 * every other share has, for the same clipboard-permission reason.
 *
 * Busy-ness is one-way: this refuses to start while the row pipeline is
 * uploading, but the row pipeline does not know about this one. The window is
 * a click landing inside another click's upload, both behind rate limits and
 * a 12 MB cap; serialising the two properly means one shared flag in a third
 * file, which is more machinery than the overlap justifies.
 */
(function (root) {
  "use strict";

  const SHARE = root.RAShareUI || require("../share/share-ui-support.js");
  const HOSTS = root.RAShareHosts || require("../share/hosts.js");
  const CONFIG = root.RAShareConfig || require("../share/config.js");
  const PANEL = root.RATrackerSharePanel || require("./share-panel.js");
  const PIPELINE = root.RATrackerSharePipeline || require("./share-pipeline.js");

  const paintYield = () => window.RARepaint.repaint(window);

  const sha256Hex = async (text) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  // Supplied by mount(): the replay reader the dashboard already holds, the
  // match array, and whether an archive is open.
  let readReplay = null;
  let matches = () => [];
  let readOnly = () => false;

  let seriesBusy = false;

  /**
   * The label a series share's record carries, and the shares list shows.
   * Pure; tested.
   */
  function seriesLabel(s, gameCount) {
    return `${String(s.format || "bo3").toUpperCase()} series vs ${s.opponentName || "unknown"} · ${
      gameCount
    } game${gameCount === 1 ? "" : "s"}`;
  }

  /**
   * The sentence the consent dialog adds under the disclosure. Pure; tested,
   * because it carries two claims that must stay true: how many games the
   * link will hold, and why the rest cannot be in it.
   */
  function consentBody(total, withReplays) {
    const missing = total - withReplays;
    return (
      `<p>${withReplays} of ${total} games still ${withReplays === 1 ? "has" : "have"} a recording ` +
      `and will be in the link${
        missing
          ? `; the ${
              missing === 1 ? "other has" : "others have"
            } none - a replay deleted by the retention setting cannot be shared`
          : ""
      }. One upload, one link, a game switcher in the viewer.</p>`
    );
  }

  async function buildSeriesFrame(s, withReplays, key) {
    const assets = new Map();
    const games = [];
    for (const g of withReplays) {
      await paintYield();
      const replay = await readReplay(g.id);
      if (!replay || !replay.events || !replay.events.length) {
        throw new PIPELINE.ShareUiError(
          `Game ${g.seriesGame || games.length + 1}'s recording could not be read.`,
          false
        );
      }
      const stripped = await window.extractCssAssets(replay.events, { hash: sha256Hex });
      // Pooled by content hash, so the site's stylesheets are carried once
      // however many games reference them.
      for (const [h, text] of stripped.assets) assets.set(h, text);
      const m = matches().find((x) => x.id === g.id) || g;
      const flags = Array.isArray(m.replayFlags) && m.replayFlags.length ? m.replayFlags : null;
      games.push({
        label: "Game " + (g.seriesGame || games.length + 1),
        result: m.result || "unknown",
        myScore: m.myScore ?? null,
        opponentScore: m.opponentScore ?? null,
        meta: flags ? Object.assign({}, replay.meta, { flags }) : replay.meta,
        events: stripped.events,
      });
    }
    await paintYield();
    return window.RAShare.buildSharePayload(
      {
        series: {
          opponentName: s.opponentName || null,
          format: s.format || "bo3",
          wins: s.wins,
          losses: s.losses,
        },
        games,
        assets: Object.fromEntries(assets),
      },
      key,
      {}
    );
  }

  async function runSeriesShare(s, withReplays) {
    const endpoint = PIPELINE.endpoint();
    const key = await window.RAShare.generateKey({});
    const frame = await buildSeriesFrame(s, withReplays, key);

    const size = SHARE.checkPayloadSize(frame.byteLength, SHARE.MAX_UPLOAD_BYTES, "This series");
    if (!size.ok) throw new PIPELINE.ShareUiError(size.message, false);

    let objectId;
    try {
      objectId = await HOSTS.hostFor("w").upload(frame, {
        endpoint,
        token: CONFIG.SHARE_TOKEN,
        fetch: (url, init) => fetch(url, init),
      });
    } catch (err) {
      throw new PIPELINE.ShareUploadError(err);
    }
    await PIPELINE.verifyObject(endpoint, objectId);

    const keyBytes = await window.RAShare.exportKey(key, {});
    const record = SHARE.shareRecord({
      // A series has no single match id, so the first shared game stands in;
      // the label is what tells the shares list what this really is.
      matchId: withReplays[0].id,
      objectId,
      key: HOSTS.toBase64Url(keyBytes),
      endpoint: HOSTS.normaliseEndpoint(endpoint),
      createdAt: Date.now(),
      label: seriesLabel(s, withReplays.length),
    });
    await PIPELINE.rememberShare(record);
    return HOSTS.buildLink({ endpoint, objectId, keyBytes });
  }

  async function shareSeries(s) {
    const notify = root.RATrackerNotify;
    if (readOnly()) return;
    if (seriesBusy || PIPELINE.busyWith()) {
      notify.say("Another share is running right now. Wait for it to finish.", "error");
      return;
    }
    const problem = SHARE.endpointProblem(PIPELINE.endpoint());
    if (problem) {
      notify.say(problem, "error");
      return;
    }
    const withReplays = (s.games || []).filter((g) => g && window.RATrackerLegacy.hasVisual(g.id));
    if (!withReplays.length) {
      notify.say("None of this series' games still has a recording, so there is nothing to share.", "error");
      return;
    }

    const ok = await notify.ask({
      title: "Share this series?",
      body: PANEL.DISCLOSURE + consentBody(s.games.length, withReplays.length),
      confirmLabel: "Create series link",
    });
    if (!ok) return;

    seriesBusy = true;
    notify.say("Preparing the series share — reading, encrypting and uploading…", "info");
    try {
      const link = await runSeriesShare(s, withReplays);
      await notify.dialog().open({
        title: "Series link created",
        body: `<div class="share-link-row">
            <input class="share-link" type="text" readonly spellcheck="false"
                   aria-label="Share link for this series" data-serieslink value="${window.RATrackerFormat.esc(link)}" />
            <button class="rp-btn" data-seriescopy>Copy link</button>
          </div>
          <p class="share-note">Uploaded and verified. It expires in ${SHARE.SHARE_TTL_DAYS} days and cannot be unshared before then.</p>`,
        actions: [{ label: "Done", value: true, kind: "primary" }],
        onMount: (dlg) => {
          const field = dlg.querySelector("[data-serieslink]");
          const copy = dlg.querySelector("[data-seriescopy]");
          if (copy) {
            copy.addEventListener("click", () =>
              window.RAClipboard.copyToButton(link, copy, { field })
            );
          }
          if (field) {
            field.focus();
            field.select();
          }
        },
      });
    } catch (err) {
      console.warn("[Rift Atlas] series share failed:", err);
      notify.say(PIPELINE.shareFailure(err).error, "error");
    } finally {
      seriesBusy = false;
    }
  }

  function mount(deps) {
    readReplay = deps.readReplay;
    matches = deps.matches;
    readOnly = deps.readOnly;
  }

  root.RATrackerShareSeries = { shareSeries, seriesLabel, consentBody, mount };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : globalThis).RATrackerShareSeries;
}
