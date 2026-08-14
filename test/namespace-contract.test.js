"use strict";

/* Every cross-file call in this extension, resolved against what the other file
 * actually publishes.
 *
 * There is no bundler and must not be one. A module publishes an object onto
 * `window` / `globalThis` - `root.RATBoard = { ... }` - and every consumer
 * reaches into it by name. Rename a published key and nothing anywhere objects:
 * there is no build step to fail, the caller reads `undefined`, and the throw
 * lands wherever that call site happens to sit. In the content script it is
 * swallowed by the try/catch around the tick (one console warning per frame,
 * capture silently dead); in the dashboard it kills whatever handler was
 * running, usually mid-render.
 *
 * An audit renamed all 256 published keys one at a time and ran the suite after
 * each. 52 renames left it green, and 19 of those were keys production code in
 * ANOTHER file calls - forgetVisual, showOrphanBanner, reportStorageFailure,
 * patchSettings, readShares/writeShares, getAll, and the rest. Writing a
 * behavioural test per key would be 19 tests that go stale the moment a
 * twentieth key appears, so this resolves the whole relation instead: every
 * `<namespace>.<member>` reference in the repo, checked against that
 * namespace's actually-published keys. One failure, at the source of the
 * rename, for any key in the set.
 *
 * Source scanning, which is the pattern the repo already uses for invariants
 * that span files - see test/content-wiring.test.js and
 * test/vendor-contract.test.js. Its two failure modes are both guarded below:
 * a shape the extractor does not understand FAILS rather than being skipped
 * (`the export shape of every published namespace is understood`), and a
 * reference it cannot resolve statically is named in the assertion of the
 * unresolvable set rather than dropped quietly. That set is empty today; the
 * failure message when it is not lists every entry.
 *
 * A SECOND audit then swept all 372 published names the same way: 330 caught, 38
 * green, and 12 of those 38 were names a production consumer in another file
 * needs. Four causes, all of them the same mistake - a shape that was dropped
 * before it could reach the unresolvable list, so the empty list read as proof
 * of exhaustiveness when it was proof of nothing:
 *
 *   1. `const LEGACY = () => window.RATrackerLegacy;` - the deferred lookup this
 *      repo PREFERS (see dashboard/notify.js) - was not a binding form the
 *      resolver read. 13 sites, 55 references, 24 members. Read now, in all
 *      three shapes: `LEGACY().m`, `const l = LEGACY()`, `const {m} = LEGACY()`,
 *      and across files, since RATrackerNotify publishes a thunk as a member.
 *   2. Template literals were blanked whole, interpolations included, in a
 *      codebase whose markup - and therefore whose calls - live in `${...}`.
 *      The masker now blanks the text and keeps the expressions.
 *   3. `createReplayStore({ idb: RATrackerIdb })` turns every later `idb.put`
 *      into a member read on a parameter. No name resolution can follow that, so
 *      it is pinned behaviourally instead, against the real module.
 *   4. Bare globals - extractCssAssets, rehydrateCssAssets, createCapturePolicy,
 *      RATrackerToast - are published without being namespace objects, and only
 *      namespace objects were modelled. Any `root.<name>` that is not a platform
 *      name (BROWSER_GLOBALS) must now resolve to something a file here
 *      publishes.
 *
 * The rule the audit's decisive criticism leaves behind: what this guard does
 * not understand must LAND in `unresolvable` and be accepted in writing. And the
 * floors below are per reference form and set just under the live counts,
 * because the audit's cheapest defeat was moving references from a form the
 * guard read to one it did not - which no single total, and no floor with a
 * hundred references of slack, can see.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.join(__dirname, "..");

/* ------------------------------------------------------------------ *
 * Lexing
 * ------------------------------------------------------------------ */

/* Blanks out comment bodies, string bodies and regex bodies while keeping every
 * offset intact, so the brace matching and the name regexes below run over code
 * only. Without it a `{` inside a template literal or a `/[{]/` character class
 * derails the object-literal walker, and prose in a comment gets read as a
 * reference. Offsets are preserved so a hit can still be reported by line.
 *
 * A template literal is NOT blanked wholesale: its text is, but the code inside
 * `${...}` is left standing. This is an HTML-in-template-literals codebase and a
 * great many cross-file calls live in exactly that position - 104 in
 * dashboard/view-matches.js alone - so blanking the interpolations too, which is
 * what treating a backtick as a quote did, dropped them all before any of the
 * resolution below could see them. Interpolations nest (a template inside `${}`
 * inside a template), hence the stack rather than a flag. */
function maskLiterals(source) {
  const out = source.split("");
  const n = source.length;
  let i = 0;
  let prev = ""; // last non-space code character, for the regex/divide decision
  const blank = (at) => {
    if (source[at] !== "\n") out[at] = " ";
  };
  /* The top of the stack says what is being read. A "code" frame is the file
   * itself or the inside of an interpolation; its `depth` counts the braces
   * opened within it, so the `}` that closes the interpolation can be told from
   * one that closes an object literal inside it. */
  const stack = [{ kind: "code", depth: 0 }];

  while (i < n) {
    const frame = stack[stack.length - 1];
    const c = source[i];
    const d = source[i + 1];

    if (frame.kind === "template") {
      if (c === "\\") {
        blank(i++);
        blank(i++);
        continue;
      }
      if (c === "`") {
        i++;
        stack.pop();
        prev = "`";
        continue;
      }
      if (c === "$" && d === "{") {
        // `${` and its `}` are left in place: they keep the brace walker balanced.
        i += 2;
        stack.push({ kind: "code", depth: 0 });
        prev = "{";
        continue;
      }
      blank(i++);
      continue;
    }

    if (c === "/" && d === "/") {
      while (i < n && source[i] !== "\n") blank(i++);
      continue;
    }
    if (c === "/" && d === "*") {
      blank(i++);
      blank(i++);
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) blank(i++);
      blank(i++);
      blank(i++);
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          blank(i++);
          blank(i++);
          continue;
        }
        if (source[i] === c) break;
        blank(i++);
      }
      i++;
      prev = c;
      continue;
    }
    if (c === "`") {
      i++;
      stack.push({ kind: "template" });
      continue;
    }
    if (c === "{") {
      frame.depth++;
    } else if (c === "}") {
      if (frame.depth === 0 && stack.length > 1) {
        i++;
        stack.pop();
        prev = "}";
        continue;
      }
      frame.depth--;
    }
    // A `/` after a value is division; after an operator or an opener it starts
    // a regex. Only the regex case needs blanking.
    if (c === "/" && /[(,=:[!&|?{};+\-*%<>~^]/.test(prev || "(")) {
      const start = i++;
      let inClass = false;
      let closed = false;
      while (i < n && source[i] !== "\n") {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        else if (source[i] === "/" && !inClass) {
          closed = true;
          break;
        }
        i++;
      }
      if (closed) {
        for (let k = start + 1; k < i; k++) blank(k);
        i++;
        prev = "/";
        continue;
      }
      i = start; // not a regex after all
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

/** Walks a balanced `{...}` from `open`, returning its top-level segments. */
function topLevelSegments(masked, open) {
  let depth = 0;
  let from = open + 1;
  const segments = [];
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) {
        segments.push(masked.slice(from, i));
        return { segments, end: i };
      }
    } else if (c === "," && depth === 1) {
      segments.push(masked.slice(from, i));
      from = i + 1;
    }
  }
  return null; // unbalanced
}

/* ------------------------------------------------------------------ *
 * What each namespace publishes
 * ------------------------------------------------------------------ */

/* The four shapes that actually occur at a publication site in this repo.
 * `defer(run) {}` in dashboard/main.js is the method-shorthand one, and it is
 * the shape the audit's own extractor missed entirely - so it was never even
 * probed. Anything else reaching here is reported, not skipped: an unrecognised
 * shape means the namespace's keys are unknown, and a guard that quietly checks
 * nothing is the exact failure this file exists to prevent. */
function objectLiteralKeys(masked, open) {
  const walked = topLevelSegments(masked, open);
  if (!walked) return { error: "unbalanced object literal" };
  const keys = [];
  /* key -> the plain identifier it was given, where it was given one. That is
   * what makes an exported thunk visible: `{ dialog }` in dashboard/notify.js is
   * the local `dialog`, and the local is `() => root.RATrackerDialog`. */
  const values = new Map();
  for (const raw of walked.segments) {
    const s = raw.trim();
    if (!s) continue; // trailing comma
    if (s.startsWith("...")) return { error: "spread element - keys are not statically known" };
    if (s.startsWith("[")) return { error: "computed key - keys are not statically known" };
    const m =
      /^([A-Za-z_$][\w$]*)$/.exec(s) || //                       { foo }
      /^([A-Za-z_$][\w$]*)\s*:/.exec(s) || //                    { foo: bar }
      /^["']([^"']+)["']\s*:/.exec(s) || //                      { "foo": bar }
      /^(?:async\s+)?(?:get|set)\s+([A-Za-z_$][\w$]*)\s*\(/.exec(s) || // { get foo() {} }
      /^(?:async\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(s); //   { foo() {} }
    if (!m) return { error: "unrecognised member syntax: " + JSON.stringify(s.slice(0, 60)) };
    keys.push(m[1]);
    const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(s);
    const named = /^[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$]*)\s*$/.exec(s);
    if (shorthand) values.set(m[1], shorthand[1]);
    else if (named) values.set(m[1], named[1]);
  }
  return { keys, values };
}

/* Everything the extension puts on the global object, not only the `RA*`
 * namespaces. Three of the names it publishes are bare - extractCssAssets and
 * rehydrateCssAssets from store/css-assets.js, createCapturePolicy from
 * capture/capture-policy.js - plus RATrackerToast, which carries the prefix but
 * is a bare function, not a namespace object. Modelling only `RA*` objects left
 * all four unguarded: renaming the publication left every consumer reading
 * `undefined` with nothing to say so.
 *
 * A name in BROWSER_GLOBALS is the platform's, not ours, so an assignment to it
 * is not a publication and a read of it is not a cross-file reference. */
const PUBLICATION = /(?<![.\w$])(?:root|window|globalThis|self)\.([A-Za-z_$][\w$]*)(?![\w$])\s*=(?!=)\s*/g;

/* The platform names this extension reads off `window` / `self`, plus the three
 * globals vendor/ publishes (guarded by test/vendor-contract.test.js, which is
 * where third-party surface belongs). Every OTHER `root.<name>` read has to
 * resolve to something a file here publishes - that inversion is what makes a
 * renamed bare global fail, and it means a new name lands in this list
 * deliberately rather than being skipped by a pattern that never saw it. */
const BROWSER_GLOBALS = new Set([
  "ResizeObserver", "addEventListener", "removeEventListener",
  "cancelAnimationFrame", "requestAnimationFrame", "cancelIdleCallback", "requestIdleCallback",
  "clearInterval", "setInterval", "clearTimeout", "setTimeout",
  "close", "crypto", "devicePixelRatio", "document", "fetch", "indexedDB",
  "innerHeight", "innerWidth", "location", "matchMedia", "navigator", "prompt", "scrollY",
  // vendor/, covered by test/vendor-contract.test.js
  "rrwebRecord", "rrwebReplay", "showdown",
]);

/* A namespace looked up at call time instead of bound: `const LEGACY = () =>
 * window.RATrackerLegacy;` and `LEGACY().logFor(...)`. dashboard/notify.js
 * documents this as the PREFERRED idiom for the dashboard's classic scripts -
 * main.js is deferred, so a name bound at evaluation time would be undefined -
 * and 13 sites carry 55 references through it. The binding form the resolver
 * understood required `root.RAX` immediately after the `=`, so every one of
 * those was invisible: the reference was neither resolved nor reported. */
const THUNK = new RegExp(
  "\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*\\(\\s*\\)\\s*=>\\s*" +
    "(?:root|window|globalThis|self)\\.([A-Za-z0-9_$]+)(?![\\w$])(?!\\s*[.(\\[?])",
  "g"
);

/** local name -> namespace it defers to, for every `() => root.RANs` in a file. */
function localThunks(masked) {
  const found = new Map();
  for (const hit of masked.matchAll(THUNK)) found.set(hit[1], hit[2]);
  return found;
}

/**
 * Reads every `root.<name> = ...` publication out of `sources`.
 *
 * Two RHS forms occur: the object literal written inline (capture/*, dashboard/*)
 * and an identifier holding one declared just above (`const api = {...};
 * root.RAShareUI = api;` in share/* and replay/*, `bridge` in legacy.js). An
 * identifier that resolves to no object literal - dashboard/main.js publishes a
 * bare function as RATrackerToast, store/css-assets.js two more - is recorded as
 * opaque: the name itself is still published and still checked, and a member
 * read off it is reported rather than assumed fine.
 */
function readPublished(sources) {
  const published = new Map();
  const shapeErrors = [];
  for (const [rel, masked] of sources) {
    const thunks = localThunks(masked);
    PUBLICATION.lastIndex = 0;
    let hit;
    while ((hit = PUBLICATION.exec(masked))) {
      const ns = hit[1];
      if (BROWSER_GLOBALS.has(ns)) continue; // assigning a platform name, not publishing
      const at = hit.index + hit[0].length;
      const rest = masked.slice(at);
      let result;
      if (rest[0] === "{") {
        result = objectLiteralKeys(masked, at);
      } else {
        const ident = /^([A-Za-z_$][\w$]*)\s*;/.exec(rest);
        if (!ident) {
          result = { error: "unrecognised right-hand side " + JSON.stringify(rest.slice(0, 48).trim()) };
        } else {
          const decl = new RegExp("\\b(?:const|let|var)\\s+" + ident[1] + "\\s*=\\s*\\{").exec(masked);
          result = decl
            ? objectLiteralKeys(masked, masked.indexOf("{", decl.index))
            : { opaque: ident[1] };
        }
      }

      const entry = published.get(ns) || { keys: new Set(), thunks: new Map(), opaque: null, sites: [] };
      entry.sites.push(rel);
      if (result.error) shapeErrors.push(rel + ": " + ns + " - " + result.error);
      else if (result.opaque) entry.opaque = rel + " publishes it as the value of `" + result.opaque + "`";
      else {
        for (const k of result.keys) entry.keys.add(k);
        // An exported thunk: RATrackerNotify.dialog() IS RATrackerDialog, and
        // four files reach the dialog only through it.
        for (const [key, value] of result.values) {
          if (thunks.has(value)) entry.thunks.set(key, thunks.get(value));
        }
      }
      published.set(ns, entry);
    }
  }
  return { published, shapeErrors };
}

/* ------------------------------------------------------------------ *
 * Who reaches into them
 * ------------------------------------------------------------------ */

/* The leading guard matters now that the name after the dot is no longer
 * required to start with `RA`: `out.self.endTurn` in dashboard/analysis.js is a
 * field of a tally called `self`, not a global read, and half a dozen such
 * fields would otherwise be reported as unpublished globals. */
const NS_ROOT = "(?<![.\\w$])(?:root|window|globalThis|self)";

/* `const MAGIC = (root.RAShare || require("./payload.js")).MAGIC;` - the one
 * place a namespace is read through a require() fallback in the same
 * expression. It is a plain cross-file reference; only the parentheses hid it. */
const PAREN_MEMBER =
  "\\(\\s*" + NS_ROOT + "\\.([A-Za-z0-9_$]+)\\s*\\|\\|[\\s\\S]{0,120}?\\)\\s*\\.([A-Za-z_$][\\w$]*)";

/* The trailing guards are what keep this honest. `(?![\w$])` stops the greedy
 * name from backing off a character to satisfy the next lookahead, and
 * `(?!\s*[.(\[?])` is the rule that killed the audit prototype's false
 * positives: `const found = root.RATDeckName.pickDeckName(...)` binds a RESULT,
 * not the namespace, and reading `found.name` afterwards is nothing to do with
 * RATDeckName's key set. Only a reference that ENDS at the namespace is an
 * alias. */
const ALIAS = new RegExp(
  "\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*" +
    NS_ROOT +
    "\\.(RA[A-Za-z0-9_]*)(?![\\w$])(?!\\s*[.(\\[?])",
  "g"
);

/** Every name bound as a parameter anywhere in the file. */
function parameterNames(masked) {
  const names = new Set();
  const add = (list) => {
    for (const part of list.split(",")) {
      const m = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(part);
      if (m) names.add(m[1]);
    }
  };
  for (const m of masked.matchAll(/\bfunction\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) add(m[1]);
  for (const m of masked.matchAll(/\bfunction\s*\(([^)]*)\)/g)) add(m[1]);
  for (const m of masked.matchAll(/\(([^()]*)\)\s*=>/g)) add(m[1]);
  for (const m of masked.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  return names;
}

/**
 * Resolves every namespace member reference in `sources`.
 *
 * Aliases are bound by name to the namespace they were actually assigned from,
 * never matched by substring or suffix - which is why `SHARE_PANEL` and `PANEL`
 * are two different aliases here and not one fuzzy match. A local name that is
 * ALSO a parameter or a second declaration somewhere in the file is dropped and
 * reported as unresolvable rather than guessed at.
 *
 * Counts are kept per reference FORM rather than as one total. A total cannot
 * tell "the alias idiom is gone" from "the alias idiom moved to the thunk
 * idiom", and it was exactly that blindness the audit exploited: converting four
 * consumers to the thunk form dropped 24 references out of the relation while
 * the total stayed comfortably above a floor with a hundred references of slack.
 */
function resolveReferences(sources, published) {
  const problems = [];
  const unresolvable = [];
  const counts = { direct: 0, alias: 0, thunk: 0, destructure: 0, global: 0 };

  for (const [rel, masked] of sources) {
    const aliases = new Map(); //  local -> namespace it holds
    const thunks = localThunks(masked); //  local -> namespace it defers to
    for (const hit of masked.matchAll(ALIAS)) aliases.set(hit[1], hit[2]);

    const check = (ns, member, reference, form) => {
      const entry = published.get(ns);
      const at = rel + ": " + reference;
      if (!entry) return problems.push(at + " - no file publishes `" + ns + "`");
      if (member === null) {
        counts[form]++;
        return;
      }
      if (entry.opaque) return problems.push(at + " - " + entry.opaque + ", so members cannot be checked");
      if (!entry.keys.has(member)) {
        return problems.push(at + " - " + entry.sites.join(" / ") + " publishes no `" + member + "`");
      }
      counts[form]++;
    };

    /* Destructures are read first: one of them binds a thunk. `const { ask,
     * dialog: DIALOG } = window.RATrackerNotify` makes DIALOG a deferred
     * RATrackerDialog, and `DIALOG().textPrompt(...)` two hundred lines later is
     * the only path four files have to the dialog at all. */
    const destructures = [];
    const fromGlobal = []; //  const { extractCssAssets } = root  - bare globals, not a namespace
    for (const hit of masked.matchAll(/\b(?:const|let|var)\s*\{/g)) {
      const walked = topLevelSegments(masked, hit.index + hit[0].length - 1);
      if (!walked) continue;
      const after = masked.slice(walked.end + 1);
      const tail = /^\s*=\s*([A-Za-z_$][\w$.]*)(?![\w$])(?!\s*[.(\[?])/.exec(after);
      // `= THUNK()` and nothing after it. `const { matches } = S().group(...)`
      // destructures what group() returned, which is not the namespace.
      const call = /^\s*=\s*([A-Za-z_$][\w$]*)\s*\(\s*\)(?!\s*[.(\[])/.exec(after);
      /* `const { extractCssAssets, rehydrateCssAssets } = <require or root>;` in
       * store/replay-store.js reads two names off the global object itself. The
       * ternary in front of it is why this looks at the END of the assignment
       * rather than its first token. */
      const rhs = /^\s*=([^;]*)/.exec(after);
      if (rhs && new RegExp(NS_ROOT + "\\s*$").test(rhs[1])) {
        fromGlobal.push(walked.segments);
        continue;
      }
      let ns = null;
      if (tail) {
        const direct = new RegExp("^" + NS_ROOT + "\\.([A-Za-z0-9_$]+)$").exec(tail[1]);
        ns = direct ? direct[1] : aliases.get(tail[1]) || null;
      } else if (call) {
        ns = thunks.get(call[1]) || null;
      }
      if (!ns) continue;
      destructures.push({ ns, segments: walked.segments });
      for (const raw of walked.segments) {
        const s = raw.trim();
        if (!s) continue;
        const renamed = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*$/.exec(s);
        const plain = /^([A-Za-z_$][\w$]*)\s*$/.exec(s);
        const member = renamed ? renamed[1] : plain ? plain[1] : null;
        const local = renamed ? renamed[2] : plain ? plain[1] : null;
        const entry = published.get(ns);
        if (member && entry && entry.thunks.has(member)) thunks.set(local, entry.thunks.get(member));
      }
    }

    const params = parameterNames(masked);
    for (const [kind, map] of [["alias", aliases], ["thunk", thunks]]) {
      for (const local of [...map.keys()]) {
        const declarations = [
          ...masked.matchAll(new RegExp("\\b(?:const|let|var|function|class)\\s+" + local + "(?![\\w$])", "g")),
        ].length;
        if (declarations > 1 || params.has(local)) {
          unresolvable.push(
            rel + ": `" + local + "` (" + kind + " for " + map.get(local) + ") is rebound elsewhere in the file"
          );
          map.delete(local);
        }
      }
    }

    /* A thunk's return value bound to a name - `const legacy = LEGACY();` in
     * view-matches.js, `const fp = FP();` in deck-labelling.js - is the
     * namespace itself, so the name is an alias like any other. */
    for (const hit of masked.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(\s*\)(?!\s*[.(\[])/g
    )) {
      if (thunks.has(hit[2]) && !aliases.has(hit[1]) && !params.has(hit[1])) aliases.set(hit[1], thunks.get(hit[2]));
    }

    /* `X().member`, and `X.member()` where the member is itself an exported
     * thunk, both read a member of the namespace on the far side of the call.
     * Anything else in the trailing position belongs to whatever the call
     * returned, which is not this namespace's business. */
    const afterCall = (from) => /^\s*\(\s*\)\s*\.([A-Za-z_$][\w$]*)/.exec(masked.slice(from));

    // root.Thing.member  (namespace objects and bare globals alike)
    for (const hit of masked.matchAll(
      new RegExp(NS_ROOT + "\\.([A-Za-z0-9_$]+)\\.([A-Za-z_$][\\w$]*)", "g")
    )) {
      if (BROWSER_GLOBALS.has(hit[1])) continue;
      check(hit[1], hit[2], hit[1] + "." + hit[2], "direct");
      const entry = published.get(hit[1]);
      const chained = entry && entry.thunks.has(hit[2]) && afterCall(hit.index + hit[0].length);
      if (chained) {
        check(entry.thunks.get(hit[2]), chained[1], hit[1] + "." + hit[2] + "()." + chained[1], "thunk");
      }
    }
    /* root.Thing on its own: the name-level half of the check, and the only one
     * available for a bare function (RATrackerToast) or a namespace handed
     * whole to someone else (`idb: self.RATrackerIdb`). Skipped where the name
     * is being published rather than read. */
    for (const hit of masked.matchAll(new RegExp(NS_ROOT + "\\.([A-Za-z0-9_$]+)(?![\\w$])", "g"))) {
      const name = hit[1];
      if (BROWSER_GLOBALS.has(name)) continue;
      const after = masked.slice(hit.index + hit[0].length);
      if (/^\s*=(?!=)/.test(after)) continue; // the publication itself
      if (/^\s*[.[]/.test(after)) continue; // handled as a member access above
      check(name, null, name, "global");
    }
    // (root.Thing || require(...)).member
    for (const hit of masked.matchAll(new RegExp(PAREN_MEMBER, "g"))) {
      if (BROWSER_GLOBALS.has(hit[1])) continue;
      check(hit[1], hit[2], "(" + hit[1] + " || ...)." + hit[2], "direct");
    }
    // root.Thing[expr]
    for (const hit of masked.matchAll(new RegExp(NS_ROOT + "\\.([A-Za-z0-9_$]+)\\s*\\[", "g"))) {
      if (BROWSER_GLOBALS.has(hit[1])) continue;
      unresolvable.push(rel + ": computed member access on " + hit[1]);
    }
    // const { name, name } = root
    for (const segments of fromGlobal) {
      for (const raw of segments) {
        const s = raw.trim();
        if (!s) continue;
        const m = /^([A-Za-z_$][\w$]*)/.exec(s);
        if (!m) {
          unresolvable.push(rel + ": unparsed destructure of the global object: " + JSON.stringify(s.slice(0, 40)));
          continue;
        }
        if (BROWSER_GLOBALS.has(m[1])) continue;
        check(m[1], null, "{ " + m[1] + " } = root", "global");
      }
    }
    // const { member, member } = root.Thing  /  = ALIAS  /  = THUNK()
    for (const { ns, segments } of destructures) {
      for (const raw of segments) {
        const s = raw.trim();
        if (!s) continue;
        if (s.startsWith("...")) {
          unresolvable.push(rel + ": rest element in a destructure of " + ns);
          continue;
        }
        const m = /^([A-Za-z_$][\w$]*)/.exec(s);
        if (m) check(ns, m[1], "{ " + m[1] + " } = " + ns, "destructure");
        else unresolvable.push(rel + ": unparsed destructure of " + ns + ": " + JSON.stringify(s.slice(0, 40)));
      }
    }
    // alias.member  /  alias[expr]
    for (const [local, ns] of aliases) {
      for (const hit of masked.matchAll(new RegExp("(?<![.\\w$])" + local + "\\.([A-Za-z_$][\\w$]*)", "g"))) {
        check(ns, hit[1], local + "." + hit[1] + "  (" + local + " = " + ns + ")", "alias");
        const entry = published.get(ns);
        const chained = entry && entry.thunks.has(hit[1]) && afterCall(hit.index + hit[0].length);
        if (chained) {
          check(entry.thunks.get(hit[1]), chained[1], local + "." + hit[1] + "()." + chained[1], "thunk");
        }
      }
      for (const _ of masked.matchAll(new RegExp("(?<![.\\w$])" + local + "\\s*\\[", "g"))) {
        unresolvable.push(rel + ": computed member access on " + local + " (= " + ns + ")");
      }
    }
    // THUNK().member, and every other use of a thunk local
    for (const [local, ns] of thunks) {
      for (const hit of masked.matchAll(new RegExp("(?<![.\\w$])" + local + "(?![\\w$])", "g"))) {
        const after = masked.slice(hit.index + local.length);
        const member = /^\s*\(\s*\)\s*\.([A-Za-z_$][\w$]*)/.exec(after);
        if (member) {
          check(ns, member[1], local + "()." + member[1] + "  (" + local + " = () => " + ns + ")", "thunk");
          continue;
        }
        // `const x = THUNK()` (aliased above), `= THUNK` (the thunk itself
        // passed on), a bare `THUNK()`, the declaration, the export.
        if (/^\s*\(\s*\)\s*\[/.test(after)) {
          unresolvable.push(rel + ": computed member access on " + local + "() (= " + ns + ")");
        }
      }
    }

    /* The honesty net. A local bound to something that ENDS at a namespace is a
     * namespace binding whatever syntax it arrived in; if none of the forms
     * above claimed it, the guard does not understand it and says so rather
     * than dropping its references on the floor. This is what the arrow-thunk
     * hole would have announced, had it existed then. */
    for (const hit of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g)) {
      const [, local, rhs] = hit;
      if (aliases.has(local) || thunks.has(local)) continue;
      const holdsNs = new RegExp(NS_ROOT + "\\.(RA[A-Za-z0-9_]*)(?![\\w$])(?!\\s*[.(\\[])").exec(rhs);
      if (!holdsNs) continue;
      if (new RegExp(PAREN_MEMBER).test(rhs)) continue; // read as a member above, not a binding
      unresolvable.push(
        rel + ": `" + local + "` is bound to " + holdsNs[1] + " by a form the resolver does not read: " +
          JSON.stringify(rhs.trim().slice(0, 60))
      );
    }
  }
  return { problems, unresolvable: [...new Set(unresolvable)].sort(), counts };
}

/* ------------------------------------------------------------------ *
 * The repo, lexed once
 * ------------------------------------------------------------------ */

/* Everything the extension ships. test/ is excluded because a test may stub a
 * namespace deliberately; vendor/ is third-party and covered by
 * test/vendor-contract.test.js; scratch/ is not shipped. */
const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "scratch", "test", "docs"]);

/* sync-assets.sh copies share/*.js, replay/*.js and store/*.js into the
 * Worker's public/ tree before a deploy, and .gitignore lists those directories
 * as generated. Scanning the copies would do two wrong things: it would make
 * this guard's results depend on whether anyone has run the sync (they are
 * absent on a fresh clone), and - because two files would then publish the same
 * namespace - a rename in one copy would be masked by the key still standing in
 * the other. The copies being faithful is test/viewer-assets.test.js's job; the
 * references in public/viewer.js, which IS source, resolve against the
 * repo-root originals, which is what the sync guarantees they are.
 *
 * Read from .gitignore rather than hardcoded so a new generated directory is
 * excluded by the same act that declares it generated. */
const GENERATED = fs
  .readFileSync(path.join(repo, ".gitignore"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#") && line.endsWith("/") && !/[*?[\]]/.test(line))
  .map((line) => line.replace(/^\/+/, ""));

function shippedJs(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(repo, full).split(path.sep).join("/");
    if (GENERATED.some((prefix) => (rel + "/").startsWith(prefix))) continue;
    if (entry.isDirectory()) shippedJs(full, found);
    else if (entry.name.endsWith(".js")) found.push(full);
  }
  return found;
}

const sources = new Map(
  shippedJs(repo)
    .sort()
    .map((full) => [path.relative(repo, full), maskLiterals(fs.readFileSync(full, "utf8"))])
);

const { published, shapeErrors } = readPublished(sources);
const { problems, unresolvable, counts } = resolveReferences(sources, published);

/* ------------------------------------------------------------------ *
 * The guards
 * ------------------------------------------------------------------ */

test("the export shape of every published namespace is understood", () => {
  /* A shape the extractor cannot read is not a namespace it may skip: its keys
   * would be unknown, and every reference into it would silently pass. Adding a
   * fifth publication shape is fine - teach objectLiteralKeys about it here. */
  assert.deepEqual(shapeErrors, []);

  // Vacuity guard, the same one test/content-wiring.test.js keeps: if the
  // publication idiom is ever changed wholesale, this scan finds nothing and
  // every test below passes over an empty relation.
  assert.ok(
    published.size >= 52,
    "only " + published.size + " published names found - has the `root.RAThing = {...}` idiom changed?"
  );
  const keyCount = [...published.values()].reduce((n, e) => n + e.keys.size, 0);
  assert.ok(keyCount >= 360, "only " + keyCount + " published keys found across " + published.size + " names");

  /* Two files publishing one namespace would have their key sets merged here,
   * and a rename in either would then be masked by the key still standing in
   * the other - which is how the generated public/ copies hid one. Whichever
   * file loads last wins in the browser too, so the ambiguity is real. */
  const duplicated = [...published]
    .filter(([, e]) => e.sites.length > 1)
    .map(([ns, e]) => ns + " is published by " + e.sites.join(" and "));
  assert.deepEqual(duplicated, []);
});

test("every namespace member the extension reads is published under that name", () => {
  /* The whole point. A renamed export fails here, once, naming both ends:
   * the file and alias that reads it, and the file that was supposed to publish
   * it. This subsumes the nine key names the boot tests happen to execute and
   * covers the rest besides. */
  assert.deepEqual(
    problems,
    [],
    problems.length + " cross-file reference(s) resolve to nothing:\n  " + problems.join("\n  ")
  );
});

/* Per FORM as well as in total, and set just under what the repo resolves today
 * (direct 109, alias 165, thunk 60, destructure 97, global 108 - 539 in all).
 *
 * These are the numbers that make the test above mean something. An earlier
 * version asserted one total with a floor a hundred references below it, and an
 * audit walked straight through the gap: converting four consumers from the
 * alias idiom to the thunk idiom - which the resolver did not read - took 24
 * references out of the relation, and nothing failed, because the total was
 * still miles above the floor and the references had not become UNRESOLVABLE,
 * they had become invisible.
 *
 * Raise them as coverage grows, and read a DROP as the finding it is:
 *   - one form down and another up, total steady, is consumers moving between
 *     idioms. Nothing is lost; re-pin both numbers and move on.
 *   - the TOTAL down means references left the relation. Either the resolver
 *     stopped reading a form it used to read, or consumers moved to one it
 *     never read. Lowering the floor is not the fix. */
const FLOORS = { direct: 105, alias: 160, thunk: 58, destructure: 95, global: 104 };
const TOTAL_FLOOR = 530;

test("every reference form is still being resolved in the numbers the repo has", () => {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const dropped = Object.entries(FLOORS)
    .filter(([form, floor]) => counts[form] < floor)
    .map(([form, floor]) => form + ": " + counts[form] + " resolved, floor is " + floor);
  assert.deepEqual(
    dropped,
    [],
    "a reference form is being resolved less than it was:\n  " + dropped.join("\n  ") +
      "\n  (all forms: " + JSON.stringify(counts) + ", total " + total + ")" +
      "\n  If consumers moved from one form to another the total holds and the other form rose;" +
      "\n  re-pin both numbers. If the total fell, references stopped being checked - find out why."
  );
  assert.ok(
    total >= TOTAL_FLOOR,
    "only " + total + " references resolved in total, floor is " + TOTAL_FLOOR + " - " +
      JSON.stringify(counts) + ". References have left the relation entirely, which is what happens when " +
      "consumers move to a binding form this file does not read."
  );
});

test("the references that cannot be resolved statically are these, and only these", () => {
  /* Listed rather than dropped. Each one is a reference the scan sees but
   * cannot decide, and leaving them implicit would let the set grow until the
   * guard covers nothing. A new entry here is a prompt to either teach the
   * resolver the form or accept it in writing, here, with a reason.
   *
   * Empty today. The forms that WOULD land here, and what they mean:
   *   - a computed member read (`NS[name]`), whose key is not a literal;
   *   - a rest element in a destructure, which names no members;
   *   - a local that is a namespace alias in one place and something else in
   *     another, which cannot be told apart by name;
   *   - a local bound to a namespace by a syntax the resolver does not read -
   *     the arrow-thunk hole, had this net existed when it opened.
   *
   * Two things are outside static resolution altogether, and are named here so
   * that "empty" is not read as "everything":
   *
   *   - a namespace INJECTED as a dependency. `createReplayStore({ idb:
   *     RATrackerIdb })` turns every later `idb.put(...)` into a member read on a
   *     parameter, and no amount of name resolution can follow it across the
   *     call. That one is pinned behaviourally instead - see the test below -
   *     and it is the only injection seam in the repo today. A second one would
   *     need the same treatment; nothing here would notice it on its own.
   *   - a namespace named by a STRING rather than by syntax, as the viewer's
   *     REQUIRED list does (`["RAReplayTimeline", ...]`, checked for presence at
   *     boot). Strings are masked before any of this runs, so such a name is
   *     invisible; the total floor above is what would notice consumers moving
   *     wholesale to a string-keyed lookup. */
  assert.deepEqual(unresolvable, []);
});

/* ------------------------------------------------------------------ *
 * The seam static resolution cannot cross
 * ------------------------------------------------------------------ */

test("the idb object injected into createReplayStore carries every method the store calls on it", () => {
  /* store/replay-store.js takes its whole I/O surface as a parameter, so
   * `idb.put` there is a read on a local, not on `RATrackerIdb` - and renaming
   * put/del/clearMatch/clearAll in store/idb.js left the resolver above with
   * nothing to say while every replay write in the extension broke.
   *
   * Both halves are pinned: the call sites, so a third injection site or a
   * different object has to come through here, and the module itself, loaded for
   * real rather than parsed, so the methods have to exist as functions. */
  const storeMasked = sources.get("store/replay-store.js");
  const used = [...new Set([...storeMasked.matchAll(/(?<![.\w$])idb\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))].sort();
  assert.ok(used.length >= 6, "only " + used.length + " idb methods found in the store - has the parameter's name changed?");

  const injections = [];
  for (const [rel, masked] of sources) {
    for (const hit of masked.matchAll(/createReplayStore\s*\(\s*\{/g)) {
      const walked = topLevelSegments(masked, hit.index + hit[0].length - 1);
      assert.ok(walked, rel + ": unbalanced createReplayStore({...}) argument");
      const idb = walked.segments.map((s) => /^\s*idb\s*:\s*([\w$.]+)\s*$/.exec(s)).find(Boolean);
      injections.push(rel + " injects " + (idb ? idb[1] : "no `idb` property"));
    }
  }
  assert.deepEqual(injections.sort(), [
    "background.js injects self.RATrackerIdb",
    "dashboard/legacy.js injects window.RATrackerIdb",
  ]);

  const idb = require("../store/idb.js");
  const missing = used.filter((m) => typeof idb[m] !== "function");
  assert.deepEqual(missing, [], "store/idb.js publishes no " + missing.join(", ") + " for the store to call");
});

/* ------------------------------------------------------------------ *
 * The guard, proving itself
 * ------------------------------------------------------------------ */

/** Runs the whole pipeline over a synthetic two-file repo. */
function scan(files) {
  const masked = new Map(Object.entries(files).map(([rel, src]) => [rel, maskLiterals(src)]));
  const shaped = readPublished(masked);
  return { ...shaped, ...resolveReferences(masked, shaped.published) };
}

test("a renamed export is caught through every reference form", () => {
  /* Without this, a change that quietly stops the resolver from resolving
   * anything leaves the two tests above passing over an empty set. Each case
   * publishes `wanted` and reads `wrong`. */
  const publications = {
    "multi-line literal": "root.RAThing = {\n  wanted,\n  other,\n};",
    "single-line literal": "root.RAThing = { wanted, other };",
    "method shorthand": "root.RAThing = {\n  other,\n  wanted(run) { return run; },\n};",
    "indirect identifier": "const api = { wanted, other };\nroot.RAThing = api;",
  };
  const references = {
    "direct member": 'root.RAThing.wrong("x");',
    "aliased member": "const T = root.RAThing;\nT.wrong();",
    "destructured": "const { wrong } = root.RAThing;",
    "destructured from an alias": "const T = root.RAThing;\nconst { wrong } = T;",
    // The deferred-lookup idiom dashboard/notify.js documents as the preferred
    // one, in each of the three shapes 13 sites in the repo use it in.
    "through a thunk": "const T = () => root.RAThing;\nT().wrong();",
    "off a thunk's result": "const T = () => root.RAThing;\nconst t = T();\nt.wrong();",
    "destructured from a thunk": "const T = () => root.RAThing;\nconst { wrong } = T();",
    // Where most of the dashboard's markup - and its calls - actually live.
    "inside a template interpolation": "const T = root.RAThing;\nconst h = `<p>${T.wrong()}</p>`;",
    "inside a nested interpolation": "const T = root.RAThing;\nconst h = `<p>${[1].map((n) => `<i>${T.wrong(n)}</i>`)}</p>`;",
    "through a require fallback": 'const v = (root.RAThing || require("./a.js")).wrong;',
  };

  for (const [shape, publish] of Object.entries(publications)) {
    for (const [form, use] of Object.entries(references)) {
      const where = shape + " / " + form;
      assert.deepEqual(scan({ "a.js": publish, "b.js": use }).shapeErrors, [], where);
      assert.equal(scan({ "a.js": publish, "b.js": use }).problems.length, 1, where + " must report the rename");
      const good = use.replace(/wrong/g, "wanted");
      assert.deepEqual(scan({ "a.js": publish, "b.js": good }).problems, [], where + " must stay silent when correct");
    }
  }
});

test("a thunk exported by one file and picked up by another resolves to the far namespace", () => {
  /* How four files reach the dialog: dashboard/notify.js publishes `dialog`,
   * which is `() => root.RATrackerDialog`, and a consumer destructures it and
   * calls `dialog().textPrompt(...)`. Two files apart from the namespace being
   * read, and RATrackerDialog.textPrompt/alert were renameable in silence. */
  const publish =
    "root.RADialog = { wanted };\n" +
    "const dialog = () => root.RADialog;\n" +
    "root.RANotify = { say, dialog };\n";
  const forms = {
    "destructured": "const { dialog } = root.RANotify;\ndialog().wrong();",
    "destructured and renamed": "const { dialog: D } = root.RANotify;\nD().wrong();",
    "off an alias": "const N = root.RANotify;\nN.dialog().wrong();",
    "off the namespace itself": "root.RANotify.dialog().wrong();",
  };
  for (const [form, use] of Object.entries(forms)) {
    assert.equal(scan({ "a.js": publish, "b.js": use }).problems.length, 1, form + " must report the rename");
    const good = use.replace("wrong", "wanted");
    assert.deepEqual(scan({ "a.js": publish, "b.js": good }).problems, [], form + " must stay silent when correct");
  }

  // ...and a member read off what the thunk's CALL returned is not a member of
  // the namespace: `dialog().confirm(opts)` returns a promise, not the dialog.
  const chained = "const { dialog } = root.RANotify;\ndialog().wanted().then(run);";
  assert.deepEqual(scan({ "a.js": publish, "b.js": chained }).problems, []);
});

test("a bare global is checked by name, whoever publishes it and whatever it holds", () => {
  /* store/css-assets.js publishes two plain functions rather than a namespace
   * object, dashboard/main.js publishes the toast as a third. Modelling only
   * `RA*` objects meant those three names were not in the relation at all: the
   * publication could be renamed and the four files that call them read
   * `undefined`. A name is a contract whether or not it holds an object. */
  const publish = "function extract() {}\nroot.extractCssAssets = extract;\nroot.RAToast = toast;\n";
  const uses = {
    "called directly": "window.extractCssAssets(events);",
    "destructured off the global": "const { extractCssAssets } = root;",
    "read as a value": "const t = root.RAToast;\nif (t) t(message);",
  };
  for (const [form, use] of Object.entries(uses)) {
    assert.deepEqual(scan({ "a.js": publish, "b.js": use }).problems, [], form + " must resolve");
    const renamed = publish.replace("extractCssAssets", "extractCssAssetsV2").replace("RAToast", "RAToastV2");
    assert.equal(scan({ "a.js": renamed, "b.js": use }).problems.length, 1, form + " must report the rename");
  }

  // A member read off a name published as a bare function cannot be checked, and
  // says so rather than passing.
  const opaque = scan({ "a.js": publish, "b.js": "root.RAToast.dismiss();" });
  assert.equal(opaque.problems.length, 1);
  assert.match(opaque.problems[0], /publishes it as the value of/);

  // The platform's own names are not this guard's business.
  assert.deepEqual(scan({ "a.js": publish, "b.js": "window.document.title = x;\nself.crypto.subtle;" }).problems, []);
});

test("template literal text is masked but its interpolations are not", () => {
  /* The masker is what decides whether the resolver ever sees a reference. A
   * `{` in markup must not reach the brace walker, and a call in `${...}` must. */
  const src = "const h = `<b class=\"x\">{not code} ${T.wanted(`${inner.deep}`)}</b>`;";
  const masked = maskLiterals(src);
  assert.equal(masked.length, src.length, "offsets must survive masking");
  assert.ok(!masked.includes("not code"), "template text must be blanked");
  assert.ok(!masked.includes("class"), "template text must be blanked");
  assert.ok(masked.includes("T.wanted"), "interpolated code must survive");
  assert.ok(masked.includes("inner.deep"), "code in a nested interpolation must survive");
});

test("an alias is bound to the namespace it was assigned from, not one that looks like it", () => {
  /* Both halves of the audit prototype's ~8 false positives.
   *
   * A result is not an alias: `const found = root.RAThing.pick()` binds what
   * pick() returned, and `found.name` says nothing about RAThing's keys. And
   * SHARE_PANEL is not PANEL: two aliases whose names contain one another must
   * resolve to two different namespaces. */
  const publish =
    "root.RAPanel = { open };\n" +
    "root.RASharePanel = { setShare };\n" +
    "root.RAThing = { pick };\n";
  const consume =
    "const PANEL = root.RAPanel;\n" +
    "const SHARE_PANEL = root.RASharePanel;\n" +
    "const found = root.RAThing.pick();\n" +
    "PANEL.open();\n" +
    "SHARE_PANEL.setShare();\n" +
    "found.name;\n";
  assert.deepEqual(scan({ "a.js": publish, "b.js": consume }).problems, []);

  // ...and the two aliases really are being checked, not merely ignored.
  const swapped = consume.replace("SHARE_PANEL.setShare()", "SHARE_PANEL.open()");
  assert.equal(scan({ "a.js": publish, "b.js": swapped }).problems.length, 1);
});
