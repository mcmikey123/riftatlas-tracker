/* Rift Atlas Stats Tracker - the dashboard's dialog
 *
 * One component replacing nine native confirm/prompt/alert calls, for a reason
 * that is not cosmetic: THE NATIVE ONES BLOCK THE EVENT LOOP.
 *
 * content.js saves the live match every three seconds, and this page reloads
 * its match array from chrome.storage.onChanged whenever it does. A native
 * confirm() freezes that: the listener does not run, the array does not
 * refresh, and the answer the user gives is applied to whatever the page was
 * holding when the dialog opened. An in-page dialog does not block - which is
 * the improvement and also the new hazard, because now the reload CAN land
 * underneath an open dialog and swap the array out from under the handler that
 * is awaiting it.
 *
 * So two things are load-bearing here:
 *
 *   - The API is promise-based. There is no way to write a non-blocking dialog
 *     with a synchronous return, and pretending otherwise with a callback pair
 *     just moves the same await into every caller.
 *   - isOpen() is exported. It is the property native modals gave away for
 *     free, and main.js's storage listener uses it to hold a reload until the
 *     dialog is answered. Without it this component is a regression, not a
 *     replacement.
 *
 * The pure decisions - button order, which button starts focused, what a
 * validator's return value means - live in dialog-support.js so they can be
 * tested without a DOM. See test/dialog.test.js.
 */
const { esc } = window.RATrackerFormat;
const SUPPORT = window.RATrackerDialogSupport;

/* Waiting callers, oldest first, and the one currently on screen.
 *
 * ONE DIALOG AT A TIME, AND A SECOND CALL QUEUES. The other two options are
 * both worse here. Rejecting means every caller needs a try/catch, and the
 * callers that can collide are the asynchronous ones - an import finishing
 * behind a delete confirm - which is exactly where an uncaught rejection would
 * go unnoticed. Resolving the newcomer as dismissed answers "no" on the user's
 * behalf, silently, to a question they were never shown. Queueing is the only
 * one where nothing is invented and nothing is lost; the cost is that a dialog
 * can appear a beat after the thing that asked for it, which is acceptable
 * because acknowledgements - the bulk of what used to be alert() - go through
 * toast.js instead and never enter this queue. */
const waiting = [];
let current = null;

let seq = 0;
const uid = (p) => `ra-dlg-${p}-${++seq}`;

/**
 * True while a dialog is on screen OR waiting for its turn.
 *
 * The queued case counts: a reload deferred until the visible dialog closes
 * would land in the gap before the next one opens, which is the same race with
 * extra steps.
 */
export function isOpen() {
  return current !== null || waiting.length > 0;
}

/**
 * The primitive. Everything else on this page is a preset of it.
 *
 * `body` and `footer` may be an HTML string or a DOM node. A string is inserted
 * as markup, so anything interpolated into one must go through
 * RATrackerFormat.esc - the wrappers below escape everything they build.
 *
 * `onMount(dialogEl, ctx)` runs once the dialog is in the document and before
 * focus is placed. `ctx` carries the two things a caller cannot reach from
 * outside: `ctx.close(value)` resolves the dialog programmatically, and
 * `ctx.guard(fn)` installs a veto - return false from it and the action does
 * not close the dialog. textPrompt is built on that guard; nothing else needs
 * it, which is why it is a second argument to onMount rather than another
 * top-level field.
 *
 * Resolves the chosen action's value, or undefined if the dialog was dismissed.
 */
export function open(spec) {
  return new Promise((resolve) => {
    waiting.push({ spec: spec || {}, resolve });
    if (!current) showNext();
  });
}

function showNext() {
  const next = waiting.shift();
  if (!next) {
    current = null;
    return;
  }
  current = next;
  present(next.spec, (value) => {
    current = null;
    next.resolve(value);
    // Synchronous, so isOpen() is never observably false between two queued
    // dialogs - the awaiting caller resumes in a microtask, by which time the
    // next one is already up.
    showNext();
  });
}

function present(spec, done) {
  /* Captured BEFORE showModal(), which moves focus into the dialog. Without
   * this the user is returned to the top of the document on close, and a
   * keyboard user who opened a row's "Delete" has to walk back down the table
   * to reach the next one. */
  const invoker = document.activeElement;

  const titleId = uid("title");
  const actions = SUPPORT.normalizeActions(spec.actions);

  const title = String(spec.title == null ? "" : spec.title);

  const dlg = document.createElement("dialog");
  dlg.className = "ra-dialog";
  // Only when there is one: aria-labelledby pointing at an empty heading names
  // the dialog "", and an empty <h2> is announced as a heading with no text.
  if (title) dlg.setAttribute("aria-labelledby", titleId);
  if (spec.width) dlg.style.maxWidth = typeof spec.width === "number" ? `${spec.width}px` : String(spec.width);

  /* A native <dialog> opened with showModal() rather than a div on a backdrop:
   * the focus trap, the inert page behind it, the top layer and the Escape key
   * are all the platform's, and every one of them is something a hand-rolled
   * overlay gets subtly wrong. */
  dlg.innerHTML = `
    <div class="ra-dialog-inner">
      ${title ? `<h2 class="ra-dialog-title" id="${titleId}">${esc(title)}</h2>` : ""}
      ${spec.sub ? `<p class="ra-dialog-sub">${esc(spec.sub)}</p>` : ""}
      <div class="ra-dialog-body" data-dialog-body></div>
      <div class="ra-dialog-foot">
        <div class="ra-dialog-note" data-dialog-note></div>
        <div class="ra-dialog-actions">
          ${actions
            .map((a, i) => `<button type="button" class="${btnClass(a.kind)}" data-action="${i}">${esc(a.label)}</button>`)
            .join("")}
        </div>
      </div>
    </div>
  `;

  fill(dlg.querySelector("[data-dialog-body]"), spec.body);
  const note = dlg.querySelector("[data-dialog-note]");
  fill(note, spec.footer);
  note.hidden = !note.firstChild;

  let settled = false;
  let guard = null;

  /* Every exit funnels through here, and it is idempotent. Escape fires the
   * dialog's own close event after our close() has already resolved, and a
   * second resolve would be harmless but a second focus restore and a second
   * remove() would not be obvious to read. */
  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (dlg.open) dlg.close();
    dlg.remove();
    /* The page re-renders on a storage change, so the element that opened this
     * dialog may have been replaced while it was up. Focusing a detached node
     * silently sends focus to <body>, so the check is not defensive noise. */
    if (invoker && invoker.isConnected && typeof invoker.focus === "function") invoker.focus();
    done(value);
  };

  const ctx = { dialog: dlg, close: finish, guard: (fn) => { guard = fn; } };

  dlg.addEventListener("click", (e) => {
    /* The backdrop is the dialog element itself - the content sits in
     * .ra-dialog-inner, which is why the padding lives there and not on the
     * dialog. A click that lands on the dialog and not on the inner box came
     * from outside the box, and cancels. */
    if (e.target === dlg) {
      finish(undefined);
      return;
    }
    const btn = e.target.closest?.("[data-action]");
    if (!btn) return;
    const action = actions[Number(btn.dataset.action)];
    if (!action) return;
    // The guard can refuse an action - a failed validation - but never a
    // cancellation. Escape and the backdrop always resolve, so a validator
    // cannot trap the user in a dialog they want to leave.
    if (guard && guard(action.value, dlg) === false) return;
    finish(action.value);
  });

  /* Escape reaches us as cancel -> close, and a close from any other cause
   * still ends here. That is the whole "the promise is never left pending"
   * guarantee: there is no path that removes this dialog without settling. */
  dlg.addEventListener("close", () => finish(undefined));

  document.body.appendChild(dlg);
  dlg.showModal();

  if (typeof spec.onMount === "function") spec.onMount(dlg, ctx);

  // Only if onMount did not claim focus for something better - the text field
  // in a prompt is a better landing place than the prompt's own OK button.
  if (!dlg.contains(document.activeElement) || document.activeElement === dlg) {
    const i = SUPPORT.focusIndex(actions);
    const btn = i === -1 ? null : dlg.querySelector(`[data-action="${i}"]`);
    if (btn) btn.focus();
  }
}

const btnClass = (kind) =>
  kind === "primary" ? "btn-primary" : kind === "danger" ? "btn-danger" : "btn-quiet";

/** `body`/`footer` are either markup or a node the caller already built. */
function fill(host, content) {
  if (!content) return;
  if (content instanceof Node) host.appendChild(content);
  else host.innerHTML = String(content);
}

/**
 * A question with two answers. Resolves true only if the affirmative action was
 * chosen - Escape, the backdrop and Cancel are all false, because "the user did
 * not say yes" is the only reading of a dismissal that is safe to act on.
 *
 * `summary` is the detail the question is about - the matches that will be
 * relabelled, the file about to replace the history - rendered in a sunk block
 * so the sentence stays short. A string, or an array of lines.
 */
export function confirm(opts) {
  const o = opts || {};
  return open({
    title: o.title || "Are you sure?",
    sub: o.sub,
    body: bodyWithSummary(o.body, o.summary),
    width: o.width,
    actions: [
      { label: o.cancelLabel || "Cancel", value: false, kind: "quiet" },
      { label: o.confirmLabel || "Confirm", value: true, kind: o.danger ? "danger" : "primary" },
    ],
  }).then((v) => v === true);
}

/** An acknowledgement that must be acknowledged. Most are not - see toast.js. */
export function alert(opts) {
  const o = opts || {};
  return open({
    title: o.title || "",
    sub: o.sub,
    body: o.body,
    width: o.width,
    actions: [{ label: o.confirmLabel || "OK", value: true, kind: "primary" }],
  }).then(() => undefined);
}

/**
 * One line of text. Resolves the typed string, or null if the user backed out -
 * the same shape native prompt() had, so a caller still distinguishes "typed
 * nothing" from "cancelled".
 *
 * The value is returned AS TYPED. Trimming here would quietly disagree with
 * whatever the validator was shown, and every caller that cares already trims.
 */
export function textPrompt(opts) {
  const o = opts || {};
  const fieldId = uid("field");
  const errId = uid("err");

  const field = document.createElement("div");
  field.className = "ra-dialog-field";
  field.innerHTML = `
    ${o.label ? `<label class="ra-dialog-label" for="${fieldId}">${esc(o.label)}</label>` : ""}
    <input class="ra-dialog-input" id="${fieldId}" type="text" autocomplete="off"
           aria-describedby="${errId}"
           value="${esc(o.value == null ? "" : o.value)}"
           placeholder="${esc(o.placeholder || "")}">
    <p class="ra-dialog-error" id="${errId}" role="alert" hidden></p>
  `;

  const body = document.createElement("div");
  fill(body, o.body);
  body.appendChild(field);

  const input = field.querySelector("input");
  const error = field.querySelector(".ra-dialog-error");

  const showError = (message) => {
    error.textContent = message || "";
    error.hidden = !message;
    input.classList.toggle("bad", !!message);
  };

  return open({
    title: o.title || "",
    sub: o.sub,
    body,
    width: o.width,
    actions: [
      { label: o.cancelLabel || "Cancel", value: null, kind: "quiet" },
      { label: o.confirmLabel || "Save", value: "submit", kind: "primary" },
    ],
    onMount(dlg, ctx) {
      /* The guard is what keeps a failed validation from closing the dialog.
       * Showing the error and then tearing the dialog down would make the
       * message unreadable and throw away what was typed. */
      ctx.guard((value) => {
        if (value !== "submit") return true;
        const message = SUPPORT.runValidate(o.validate, input.value);
        if (!message) {
          ctx.close(input.value);
          return false;
        }
        showError(message);
        input.focus();
        input.select();
        return false;
      });

      // Return submits, the way it did in the native prompt this replaces.
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        dlg.querySelector(".ra-dialog-actions .btn-primary")?.click();
      });
      // Typing is the user's answer to the error, so the error goes when they
      // start giving it rather than sitting there contradicting the field.
      input.addEventListener("input", () => showError(""));

      input.focus();
      input.select();
    },
  }).then((v) => (typeof v === "string" ? v : null));
}

/** A string or a list of lines under the question, in a sunk block. */
function bodyWithSummary(body, summary) {
  if (!summary) return body;
  const lines = Array.isArray(summary) ? summary : [summary];
  const items = lines
    .filter((l) => l !== null && l !== undefined && String(l) !== "")
    .map((l) => `<li>${esc(l)}</li>`)
    .join("");
  if (!items) return body;

  const host = document.createElement("div");
  fill(host, body);
  const box = document.createElement("ul");
  box.className = "ra-dialog-summary";
  box.innerHTML = items;
  host.appendChild(box);
  return host;
}
