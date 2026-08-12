/* Rift Atlas Stats Tracker - one-line acknowledgements
 *
 * Fourteen of the native alert() calls this redesign is removing are not
 * questions. "Labelled 3 matches", "Every match already has a deck name",
 * "Import failed: unexpected end of JSON input" - the user has nothing to
 * decide, and the only reason those were modal is that alert() was the shortest
 * thing to type.
 *
 * Routing them through dialog.js would make that worse rather than better: a
 * focus-trapping modal, a button to press, and the page behind it inert, all to
 * be told something already went right. So they go here instead. A toast never
 * blocks, never traps focus, and never takes focus away from what the user was
 * doing - it is announced, it is dismissable, and it leaves.
 *
 * The dividing line is whether an answer is needed. If the code branches on
 * what the user says, it is dialog.js. If it does not, it is this.
 */
const { esc } = window.RATrackerFormat;

const DEFAULT_TIMEOUT = 4000;

/* Errors get three times as long, and no longer than that.
 *
 * They carry the only detail the user gets about a failure - an exception
 * message, a file that would not parse - and four seconds is not enough to read
 * one, let alone read it twice. But they are not made sticky either: the page
 * repaints every three seconds behind them, batch operations emit several in a
 * row, and toasts that only leave when clicked accumulate into a corner of
 * litter that hides the newest one. Twelve seconds is the compromise. A caller
 * with something genuinely unrecoverable can pass `timeout: 0` and own the
 * dismissal itself. */
const ERROR_TIMEOUT = 12000;

/* Older toasts are dropped past this. "Labelled 3 matches" style messages come
 * in bursts, and a stack tall enough to reach the header stops being a status
 * line and starts being a wall. */
const MAX_VISIBLE = 4;

const KINDS = ["info", "success", "error"];

let host = null;

/* One container, created on first use and never removed. Rebuilding it per
 * toast would re-announce the live region and, in some screen readers, drop the
 * first message of every burst. */
function container() {
  if (host && host.isConnected) return host;
  host = document.createElement("div");
  host.className = "ra-toasts";
  // Polite: an acknowledgement must not interrupt whatever the reader is in
  // the middle of. Errors override this per toast with role="alert".
  host.setAttribute("aria-live", "polite");
  host.setAttribute("aria-atomic", "false");
  document.body.appendChild(host);
  return host;
}

/**
 * Show one line. Returns a function that dismisses it early, for the rare
 * caller that wants to clear its own message when the state it described
 * changes.
 *
 * `timeout` is in ms; 0 means it stays until dismissed.
 */
export function toast(message, opts) {
  const o = opts || {};
  const kind = KINDS.indexOf(o.kind) === -1 ? "info" : o.kind;
  const text = String(message == null ? "" : message);
  if (!text) return () => {};

  const wrap = container();
  const el = document.createElement("div");
  el.className = `ra-toast ra-toast-${kind}`;
  // An error is the one kind worth interrupting for: it says something the user
  // asked for did not happen, and a polite queue can leave that unread until
  // after the next thing they type.
  if (kind === "error") el.setAttribute("role", "alert");
  el.innerHTML = `
    <span class="ra-toast-text">${esc(text)}</span>
    <button type="button" class="ra-toast-close" aria-label="Dismiss">×</button>
  `;

  let timer = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    el.remove();
  };

  el.querySelector(".ra-toast-close").addEventListener("click", dismiss);
  wrap.appendChild(el);

  // Oldest first, so the message just added is never the one evicted.
  while (wrap.children.length > MAX_VISIBLE) wrap.firstElementChild.remove();

  const ms = Number.isFinite(o.timeout) ? o.timeout : kind === "error" ? ERROR_TIMEOUT : DEFAULT_TIMEOUT;
  if (ms > 0) timer = setTimeout(dismiss, ms);

  return dismiss;
}

/**
 * Drop everything on screen. For the transitions where the messages describe a
 * state that no longer exists - opening or closing an archive, where every
 * toast about the live history is now about a different set of matches.
 */
export function clearToasts() {
  if (host) host.replaceChildren();
}
