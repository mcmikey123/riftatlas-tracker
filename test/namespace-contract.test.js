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
 * test/vendor-contract.test.js.
 *
 * ------------------------------------------------------------------------
 * WHY THIS FILE IS SHAPED THE WAY IT IS
 *
 * Three audits have defeated three versions of this guard, each by writing a
 * reference in a syntax the previous version did not enumerate:
 *
 *   1. nine renames found by eye, which was a sample and not a sweep; the
 *      mechanical sweep found 19.
 *   2. the deferred-lookup idiom this repo prefers - `const LEGACY = () =>
 *      window.RATrackerLegacy;` - which was not a binding form the resolver
 *      read. Converting four consumers to it dropped 24 references and nothing
 *      failed.
 *   3. OPTIONAL CHAINING. `window.RATrackerStorage.writeShares(...)` written
 *      `window.RATrackerStorage?.writeShares(...)`. Every count held, the suite
 *      stayed green, and renaming `writeShares` afterwards passed 806/806 with
 *      both production consumers live.
 *
 * All three are one bug. The resolver was a set of regexes for enumerated
 * syntaxes with an OPEN BOTTOM: a `root.NS` read that no member pattern matched
 * fell through to the name-level check and was counted as RESOLVED. An unread
 * member syntax therefore did not merely vanish - it was reported as coverage,
 * which is why every floor stayed satisfied while the members went unchecked.
 *
 * So the shape of this version is not "one more syntax". It is:
 *
 *   a. Whether there IS a member access on a namespace value is decided
 *      SEPARATELY from whether that member access can be read, and it is decided
 *      by enumerating the OTHER side. `accessorAt` reads the accessors it knows;
 *      everything else it checks against TERMINATOR_AT, the closed list of
 *      operators and separators that can mean "this value ends here". A token
 *      that is neither is an access this file cannot read, and `readAccess`
 *      sends it to `unresolvable`. There is no path at all from "followed by
 *      something unrecognised" to "counted as a name-level read", which is what
 *      makes the NEXT unknown syntax announce itself rather than hide: `?.` is
 *      not a terminator, so it would have failed here even before anyone taught
 *      this file what optional chaining is.
 *   b. A namespace value is recognised in ONE place - `namespaceValue`, a small
 *      recursive reader of expressions - which every binding site asks: a
 *      `const`, an arrow or function thunk body, the right-hand side of a
 *      destructure. Adding a binding syntax is a change in one function rather
 *      than a fourth regex, and an expression it cannot decide is reported.
 *   c. A name-level read that nobody takes a member off is classified by what
 *      BECOMES of it. Tested, compared, called, or bound by a form the resolver
 *      read: nothing more to check. Passed as an argument, stored in an object
 *      or an array, returned, or bound by a form the resolver did NOT read: the
 *      value has moved somewhere no name resolution follows, and it lands in
 *      `unresolvable` rather than being counted.
 *   d. The name-level count is floored SEPARATELY from the member-level ones and
 *      excluded from their total, because it is a different check. It was the
 *      bucket the degraded member reads fell into, and a bucket that grows when
 *      member checks are lost cannot also be what proves they are not.
 *
 * What `unresolvable` means, exactly, and it is worth being precise because two
 * rounds have overclaimed here: it holds every namespace-valued expression the
 * scan SEES but cannot decide. It does not and cannot mean "there is nothing
 * else": a namespace that reaches another file through a function parameter is
 * outside static name resolution altogether, and those seams are listed by name
 * at the assertion below rather than pretended away. What is guaranteed is
 * narrower and checkable: no member access on a namespace value in scanned
 * source is silently dropped, and no namespace value escapes this file's names
 * without being named in that list.
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
 * Brackets and expression edges
 * ------------------------------------------------------------------ */

const OPENERS = "([{";
const CLOSERS = ")]}";

/** Index of the bracket closing the one at `open`, or null. */
function matchingClose(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** Index of the innermost bracket still open at `from`, or null. */
function enclosingOpen(masked, from) {
  let depth = 0;
  for (let i = from - 1; i >= 0; i--) {
    const c = masked[i];
    if (CLOSERS.includes(c)) depth++;
    else if (OPENERS.includes(c)) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return null;
}

/* A `(` after a value is a call or an index; after an operator, a keyword or an
 * opener it groups an expression. Same decision the masker makes for `/`, and
 * the reason `f(root.RANs).m` is a member of what f returned while
 * `(root.RANs || fallback).m` is a member of the namespace. */
const EXPRESSION_KEYWORDS = new Set([
  "return", "typeof", "void", "delete", "await", "yield", "throw", "new", "case",
  "in", "of", "instanceof", "if", "while", "for", "switch", "catch", "do", "else",
]);

/* A statement's parentheses hold a test, not a value: nothing follows `if (x)`
 * that is a member of x. They are grouping parens for the purpose of telling a
 * call from a group, and NOT ones a value can be followed out of. */
const STATEMENT_KEYWORDS = new Set(["if", "while", "for", "switch", "catch"]);

function wordBefore(masked, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(masked[i])) i--;
  if (i < 0) return "";
  if (!/[\w$]/.test(masked[i])) return masked[i];
  let j = i;
  while (j >= 0 && /[\w$]/.test(masked[j])) j--;
  return masked.slice(j + 1, i + 1);
}

function opensGroup(masked, open) {
  const before = wordBefore(masked, open);
  if (before === "") return true;
  if (/^[\w$]/.test(before)) return EXPRESSION_KEYWORDS.has(before);
  return !")]".includes(before);
}

/** A `{` that holds an object literal rather than a block. */
function opensObjectLiteral(masked, open) {
  const before = wordBefore(masked, open);
  if (before === "") return false;
  if (/^[\w$]/.test(before)) return before === "return" || before === "case";
  return "(,=:[?".includes(before) || before === ">"; // `=>` ends in `>`
}

/** Where the initialiser starting at `from` ends: its `;`, its `,`, or the
 *  bracket that closes around it. */
function initialiserEnd(masked, from) {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (c === ";" || c === ",")) return i;
  }
  return masked.length;
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

/* ------------------------------------------------------------------ *
 * Reading a namespace value, and reading an access off one
 * ------------------------------------------------------------------ */

/* The leading guard matters now that the name after the dot is no longer
 * required to start with `RA`: `out.self.endTurn` in dashboard/analysis.js is a
 * field of a tally called `self`, not a global read, and half a dozen such
 * fields would otherwise be reported as unpublished globals. */
const NS_ROOT = "(?<![.\\w$])(?:root|window|globalThis|self)";
const ROOT_READ = new RegExp(NS_ROOT + "\\.([A-Za-z0-9_$]+)(?![\\w$])", "g");
const ROOT_READ_AT = new RegExp(NS_ROOT + "\\.([A-Za-z0-9_$]+)(?![\\w$])", "y");
const ROOT_ALONE_AT = new RegExp(NS_ROOT + "(?![\\w$.])", "y");
const IDENT_AT = /[A-Za-z_$][\w$]*/y;

/* THE CLOSED BOTTOM, AND WHY IT IS CLOSED THE WAY ROUND IT IS.
 *
 * Every previous version enumerated the ACCESS syntaxes and let everything else
 * fall through to "no access here". That is an open bottom: the fall-through
 * bucket is unbounded, so an access syntax nobody had enumerated - `?.`, as it
 * turned out - was not merely missed, it was counted as coverage.
 *
 * This enumerates the other side. What may follow a namespace value and mean
 * the value ENDS HERE is a closed, finite list of JavaScript's operators,
 * closers and separators - TERMINATOR_AT below - and it is closed because the
 * grammar closes it. Anything else standing where an access could stand IS an
 * access; if the accessors here can read it, it names a member, and if they
 * cannot, it is `computed` or `unreadable` and gets reported.
 *
 * The test of a rule like this is whether it catches the shape it was not
 * taught. Delete the two `\?\.` accessor branches below - putting the file back
 * to knowing nothing about optional chaining - and `NS?.writeShares` does not
 * become a bare name read: `?.` is not a terminator, so it lands in
 * `unreadable` and fails. That is the property, and there is a test for it. */
const ACCESSOR_AT = /\s*(?:(\?\.\s*\()|(\?\.\s*\[|\[)|(?:\?\.|\.)\s*([A-Za-z_$][\w$]*))/y;

/* The value ends here: an operator that consumes it, a bracket that closes
 * around it, a separator, a call's or a tagged template's opener, or the end of
 * the file. `\?\?` and a ternary's `\?` are terminators; `?.` is deliberately
 * not, and neither is anything this list does not name. */
const TERMINATOR_AT =
  /\s*(?:=>|={1,3}|!==?|<<?=?|>>>?=?|[-+*/%&|^]=|\*\*=?|\+\+|--|&&=?|\|\|=?|\?\?=?|[-+*/%&|^~<>]|\?(?!\.)|[)\]},;]|:(?!:)|\(|`|\b(?:instanceof|in|of|as)\b|$)/y;

function accessorAt(masked, from) {
  ACCESSOR_AT.lastIndex = from;
  const m = ACCESSOR_AT.exec(masked);
  if (m) {
    if (m[1]) return { kind: "call", end: ACCESSOR_AT.lastIndex };
    if (m[2]) return { kind: "computed", end: ACCESSOR_AT.lastIndex, text: m[0].trim() };
    return { kind: "named", name: m[3], end: ACCESSOR_AT.lastIndex };
  }
  TERMINATOR_AT.lastIndex = from;
  if (TERMINATOR_AT.exec(masked)) return { kind: "none", end: from };
  return { kind: "unreadable", end: from, text: masked.slice(from, from + 12).trim() };
}

/** `()` or `?.()`, the call in `THUNK().member`. */
const EMPTY_CALL_AT = /\s*(?:\?\.)?\(\s*\)/y;

function callEnd(masked, from) {
  EMPTY_CALL_AT.lastIndex = from;
  return EMPTY_CALL_AT.exec(masked) ? EMPTY_CALL_AT.lastIndex : null;
}

/* A value in parentheses is still that value: `(root.RAShare ||
 * require("./payload.js")).MAGIC` reads MAGIC off the namespace. Following the
 * value out through its grouping parens is what makes that a general rule
 * rather than the special-cased regex it used to be - and a call's parentheses
 * are excluded, because `f(root.RANs).m` reads a member of what f returned. */
function accessOn(masked, from) {
  let pos = from;
  for (let step = 0; step < 4; step++) {
    const acc = accessorAt(masked, pos);
    if (acc.kind !== "none") return acc;
    const open = enclosingOpen(masked, pos);
    if (open === null || masked[open] !== "(" || !opensGroup(masked, open)) return acc;
    if (STATEMENT_KEYWORDS.has(wordBefore(masked, open))) return acc;
    const close = matchingClose(masked, open);
    if (close === null) return acc;
    pos = close + 1;
  }
  return { kind: "none", end: pos };
}

const NOTHING = { none: true };

/* Splits an expression at its loosest value-choosing operator, so `a ? b : c`,
 * `a || b` and `a ?? b` are read as "the value is one of these". `&&` chooses
 * its LAST operand, which is why only that one comes back. */
function operands(masked, start, end) {
  let depth = 0;
  let ternary = 0;
  const question = [];
  const colon = [];
  const or = [];
  const and = [];
  for (let i = start; i < end; i++) {
    const c = masked[i];
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) depth--;
    else if (depth !== 0) continue;
    else if (c === "?" && masked[i + 1] === "?") {
      or.push(i);
      i++;
    } else if (c === "?" && masked[i + 1] !== ".") {
      if (ternary === 0) question.push(i);
      ternary++;
    } else if (c === ":") {
      ternary--;
      if (ternary === 0) colon.push(i);
    } else if (c === "|" && masked[i + 1] === "|") {
      or.push(i);
      i++;
    } else if (c === "&" && masked[i + 1] === "&") {
      and.push(i);
      i++;
    }
  }
  if (question.length && colon.length) return [[question[0] + 1, colon[0]], [colon[0] + 1, end]];
  if (or.length) {
    const parts = [];
    let from = start;
    for (const at of or) {
      parts.push([from, at]);
      from = at + 2;
    }
    parts.push([from, end]);
    return parts;
  }
  if (and.length) return [[and[and.length - 1] + 2, end]];
  return null;
}

/** One namespace-valued result, or `unknown` when the operands disagree. */
function mergeValues(values) {
  const puzzling = values.find((v) => v.unknown);
  if (puzzling) return puzzling;
  const held = values.filter((v) => v.ns || v.globalObject);
  const names = [...new Set(held.map((v) => v.ns || "the global object"))];
  if (names.length === 0) return NOTHING;
  if (names.length > 1) return { unknown: "it holds one of " + names.join(" or ") };
  return held[0];
}

/**
 * THE ONE READER OF A NAMESPACE-VALUED EXPRESSION.
 *
 * Every binding site asks this and only this: a `const`, an arrow or function
 * thunk body, the right-hand side of a destructure. Three previous rounds each
 * had a separate regex per binding syntax, and each was beaten by a binding
 * syntax nobody had written a regex for; teaching this one function a fourth
 * shape teaches every site at once, and an expression it cannot decide comes
 * back as `unknown` and is reported rather than dropped.
 *
 * Returns `{ ns, at }` for a namespace (with the offset of the `root.NS` read
 * it consumed, so the name-level pass can tell a binding it understood from one
 * it did not), `{ globalObject }` for the global object itself, `{ unknown }`
 * for an expression that holds a namespace by a route this cannot follow, and
 * `NOTHING` for an expression whose value is not a namespace at all.
 */
function namespaceValue(masked, from, to, locals) {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(masked[start])) start++;
  while (end > start && /\s/.test(masked[end - 1])) end--;
  if (start >= end) return NOTHING;

  if (masked[start] === "(" && matchingClose(masked, start) === end - 1) {
    return namespaceValue(masked, start + 1, end - 1, locals);
  }
  const split = operands(masked, start, end);
  if (split) return mergeValues(split.map(([a, b]) => namespaceValue(masked, a, b, locals)));

  ROOT_READ_AT.lastIndex = start;
  const root = ROOT_READ_AT.exec(masked);
  if (root) {
    // Only a read that ENDS at the namespace holds one. `root.RAThing.pick()`
    // binds what pick() returned; its `.pick` is checked by the member pass.
    // A platform name is not ours to track: `const doc = document` binds the
    // document, and `doc.createElement` is nobody's cross-file reference.
    if (BROWSER_GLOBALS.has(root[1])) return NOTHING;
    return ROOT_READ_AT.lastIndex === end ? { ns: root[1], at: start } : NOTHING;
  }
  ROOT_ALONE_AT.lastIndex = start;
  if (ROOT_ALONE_AT.exec(masked) && ROOT_ALONE_AT.lastIndex === end) return { globalObject: true };

  IDENT_AT.lastIndex = start;
  const ident = IDENT_AT.exec(masked);
  if (ident) {
    const local = ident[0];
    if (locals.aliases.has(local) && IDENT_AT.lastIndex === end) {
      return { ns: locals.aliases.get(local), at: start };
    }
    if (locals.thunks.has(local)) {
      const called = callEnd(masked, IDENT_AT.lastIndex);
      if (called === end) return { ns: locals.thunks.get(local), at: start };
    }
  }
  return NOTHING;
}

/* ------------------------------------------------------------------ *
 * The locals of one file
 * ------------------------------------------------------------------ */

const DECLARATION = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/g;
const DESTRUCTURE = /\b(?:const|let|var)\s*\{/g;
const FUNCTION_DECL = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\{/g;
const ARROW_AT = /\s*(?:async\s+)?\(\s*\)\s*=>\s*/y;
const FUNCTION_EXPR_AT = /\s*(?:async\s+)?function\s*(?:[A-Za-z_$][\w$]*)?\s*\(\s*\)\s*(?=\{)/y;
const RETURN_BODY_AT = /\s*\{\s*return\s+/y;

/** The expression a `{ return X; }` body hands back, or null. */
function returnedExpression(masked, brace) {
  RETURN_BODY_AT.lastIndex = brace;
  if (!RETURN_BODY_AT.exec(masked)) return null;
  const from = RETURN_BODY_AT.lastIndex;
  const to = initialiserEnd(masked, from);
  return from < to ? [from, to] : null;
}

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
 * Every local in one file that holds a namespace, or defers to one.
 *
 * Aliases are bound by name to the namespace they were actually assigned from,
 * never matched by substring or suffix - which is why `SHARE_PANEL` and `PANEL`
 * are two different aliases here and not one fuzzy match.
 *
 * Run to a fixpoint because the bindings feed one another: a destructure can
 * bind a thunk another file exported (`const { dialog } = NOTIFY`), and a
 * `const` can bind what that thunk returns (`const d = dialog()`).
 *
 * `claimed` collects the offset of every `root.NS` read that some binding here
 * consumed. That is what lets the name-level pass tell "bound by a form the
 * resolver reads, so its members are checked elsewhere" from "bound by a form
 * the resolver does not read, so its members are checked NOWHERE" - the second
 * being precisely how the arrow-thunk round was lost.
 */
function collectLocals(masked, published) {
  const locals = { aliases: new Map(), thunks: new Map() };
  const claimed = new Set();
  const puzzles = new Map(); //  offset -> why this binding could not be read
  const destructures = new Map(); //  offset -> { ns, segments }
  const fromGlobal = new Map(); //  offset -> segments

  const take = (value, bind) => {
    if (value.ns) {
      bind(value.ns);
      if (value.at !== undefined) claimed.add(value.at);
    }
    return value;
  };

  const readDeclarations = () => {
    DECLARATION.lastIndex = 0;
    for (const hit of masked.matchAll(DECLARATION)) {
      const local = hit[1];
      const from = hit.index + hit[0].length;
      const to = initialiserEnd(masked, from);
      ARROW_AT.lastIndex = from;
      FUNCTION_EXPR_AT.lastIndex = from;
      const arrow = ARROW_AT.exec(masked);
      const fn = arrow ? null : FUNCTION_EXPR_AT.exec(masked);
      if (arrow || fn) {
        const bodyAt = arrow ? ARROW_AT.lastIndex : FUNCTION_EXPR_AT.lastIndex;
        const body = masked[bodyAt] === "{" || fn ? returnedExpression(masked, bodyAt) : [bodyAt, to];
        if (!body) continue;
        const value = take(namespaceValue(masked, body[0], body[1], locals), (ns) => locals.thunks.set(local, ns));
        if (value.unknown) puzzles.set(from, "`" + local + "` defers to a namespace but " + value.unknown);
        continue;
      }
      const value = take(namespaceValue(masked, from, to, locals), (ns) => locals.aliases.set(local, ns));
      if (value.unknown) puzzles.set(from, "`" + local + "` holds a namespace but " + value.unknown);
    }
    FUNCTION_DECL.lastIndex = 0;
    for (const hit of masked.matchAll(FUNCTION_DECL)) {
      const body = returnedExpression(masked, hit.index + hit[0].length - 1);
      if (!body) continue;
      take(namespaceValue(masked, body[0], body[1], locals), (ns) => locals.thunks.set(hit[1], ns));
    }
  };

  const readDestructures = () => {
    DESTRUCTURE.lastIndex = 0;
    for (const hit of masked.matchAll(DESTRUCTURE)) {
      const open = hit.index + hit[0].length - 1;
      const walked = topLevelSegments(masked, open);
      if (!walked) continue;
      const eq = /^\s*=(?!=)/.exec(masked.slice(walked.end + 1, walked.end + 8));
      if (!eq) continue; // `for (const { a } of list)` binds no initialiser
      const from = walked.end + 1 + eq[0].length;
      const value = namespaceValue(masked, from, initialiserEnd(masked, from), locals);
      /* `const { extractCssAssets, rehydrateCssAssets } = <require or root>;` in
       * store/replay-store.js reads two names off the global object itself. */
      if (value.globalObject) {
        fromGlobal.set(open, walked.segments);
        continue;
      }
      if (value.unknown) {
        puzzles.set(open, "a destructure reads members of a namespace but " + value.unknown);
        continue;
      }
      if (!value.ns) continue;
      if (value.at !== undefined) claimed.add(value.at);
      destructures.set(open, { ns: value.ns, segments: walked.segments });
      /* One of these binds a thunk. `const { ask, dialog: DIALOG } =
       * window.RATrackerNotify` makes DIALOG a deferred RATrackerDialog, and
       * `DIALOG().textPrompt(...)` two hundred lines later is the only path four
       * files have to the dialog at all. */
      const entry = published.get(value.ns);
      if (!entry) continue;
      for (const raw of walked.segments) {
        const s = raw.trim();
        const renamed = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*$/.exec(s);
        const plain = /^([A-Za-z_$][\w$]*)\s*$/.exec(s);
        const member = renamed ? renamed[1] : plain ? plain[1] : null;
        const local = renamed ? renamed[2] : plain ? plain[1] : null;
        if (member && entry.thunks.has(member)) locals.thunks.set(local, entry.thunks.get(member));
      }
    }
  };

  for (let round = 0; round < 4; round++) {
    const size = locals.aliases.size + locals.thunks.size;
    readDeclarations();
    readDestructures();
    if (round > 0 && locals.aliases.size + locals.thunks.size === size) break;
  }
  return { locals, claimed, puzzles, destructures, fromGlobal };
}

/* ------------------------------------------------------------------ *
 * What each namespace publishes, read out of the source
 * ------------------------------------------------------------------ */

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
    // Publication only needs the thunk half of the locals, and the namespaces
    // are not known yet, so this pass runs against an empty publication map.
    const { locals } = collectLocals(masked, new Map());
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
          if (locals.thunks.has(value)) entry.thunks.set(key, locals.thunks.get(value));
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

/* Where the value of a name-level read ends up. `expressionEnd` walks to the
 * end of the expression the read is part of, so `f(root.RANs || fallback)` is
 * judged by the argument list it lands in and not by the `||` next to it; a
 * read used as a ternary's CONDITION ends at the `?`, because a condition goes
 * nowhere. */
function expressionEnd(masked, from) {
  let depth = 0;
  let ternary = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (depth !== 0) continue;
    else if (c === ";" || c === ",") return i;
    else if (c === "?" && masked[i + 1] !== "." && masked[i + 1] !== "?") return i;
    else if (c === ":" && ternary > 0) ternary--;
  }
  return masked.length;
}

/**
 * What becomes of a namespace value nobody reads a member off - the name-level
 * half of the closed bottom.
 *
 * A read that stays inside its expression (tested, compared, called) or that a
 * binding above consumed needs nothing further: the name itself is checked, and
 * any member read goes through a local this file tracks. A read that MOVES -
 * into an argument, an object property, an array, a return, or a binding the
 * resolver could not read - carries the namespace somewhere name resolution
 * does not follow, so it is named rather than counted. Returns null when there
 * is nothing to report.
 */
function escapeOf(masked, start, end, claimed, acc) {
  if (claimed.has(start)) return null;
  // `root.createCapturePolicy({...})` and `root.RAToast?.(message)`: what moves
  // on from here is what the call RETURNED, which is not the namespace.
  if (acc.kind === "call" || /^\s*\(/.test(masked.slice(end, end + 8))) return null;
  const stop = expressionEnd(masked, end);
  const c = masked[stop];
  // A ternary's condition goes nowhere: `x ? a : b` hands on a or b.
  if (c === "?") return null;
  const before = wordBefore(masked, start);
  if (before === "return") return "returned from a function";
  if (before === ">" && masked.slice(0, start).trimEnd().endsWith("=>")) {
    return "returned from an arrow function";
  }
  // `=` here is an assignment, not the tail of `===`, `!==`, `>=` or `+=`.
  if (before === "=" && !/[=!<>+\-*/%&|^]/.test(masked[masked.lastIndexOf("=", start) - 1] || "")) {
    /* The CommonJS footer every module carries. It mirrors the namespace for
     * `require()`, whose consumers are tests - excluded from this scan - and the
     * name it reads is checked like any other. */
    if (/module\s*\.\s*exports\s*=\s*$/.test(masked.slice(Math.max(0, start - 40), start))) return null;
    return "bound by a form the resolver does not read";
  }
  if (c === undefined || c === ";") return null;
  if (c === "," || CLOSERS.includes(c)) {
    const open = enclosingOpen(masked, start);
    if (open === null) return null;
    if (masked[open] === "(") return opensGroup(masked, open) ? null : "an argument to a call";
    if (masked[open] === "{") return opensObjectLiteral(masked, open) ? "a property of an object" : null;
    if (masked[open] === "[") return "an element of an array";
  }
  return null;
}

/**
 * Resolves every namespace member reference in `sources`.
 *
 * Counts are kept per reference FORM rather than as one total. A total cannot
 * tell "the alias idiom is gone" from "the alias idiom moved to the thunk
 * idiom", and it was exactly that blindness the second audit exploited:
 * converting four consumers to the thunk form dropped 24 references out of the
 * relation while the total stayed comfortably above a floor with a hundred
 * references of slack. `global` is counted apart from the rest because it is a
 * NAME-level check and the others are MEMBER-level ones; it was the bucket the
 * optional-chaining round's degraded member reads fell into.
 */
function resolveReferences(sources, published) {
  const problems = [];
  const unresolvable = [];
  const counts = { direct: 0, alias: 0, thunk: 0, destructure: 0, global: 0 };

  for (const [rel, masked] of sources) {
    const { locals, claimed, puzzles, destructures, fromGlobal } = collectLocals(masked, published);
    const { aliases, thunks } = locals;
    for (const why of puzzles.values()) unresolvable.push(rel + ": " + why);

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

    /* THE ONE PLACE AN ACCESS IS ACTED ON. Whether there is an access was
     * decided by `accessOn`; this decides what to do about it, and there is no
     * branch here that turns an access into "no access". A member read that
     * cannot be resolved to a name is reported - never counted, and never
     * quietly handed to the name-level check.
     *
     * `chain` after it: `NS.dialog()` and `ALIAS.dialog()` call an exported
     * thunk, and what comes back is the FAR namespace, so the access after the
     * call is checked against that one. */
    const readAccess = (ns, acc, reference, form) => {
      if (acc.kind === "named") {
        check(ns, acc.name, reference + "." + acc.name, form);
        return acc.name;
      }
      if (acc.kind === "computed") {
        unresolvable.push(rel + ": computed member access on " + reference);
      } else if (acc.kind === "unreadable") {
        unresolvable.push(
          rel + ": member access on " + reference + " in a form the resolver cannot read: " +
            JSON.stringify(acc.text)
        );
      }
      return null;
    };

    const chain = (ns, member, acc, reference) => {
      const entry = published.get(ns);
      if (!member || !entry || !entry.thunks.has(member)) return;
      const called = callEnd(masked, acc.end);
      if (called === null) return;
      readAccess(entry.thunks.get(member), accessOn(masked, called), reference + "." + member + "()", "thunk");
    };

    const params = parameterNames(masked);
    /* A local that is a namespace in one place and a parameter or a second
     * declaration in another cannot be told apart by name, so it is dropped and
     * reported rather than guessed at. */
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

    /* root.Thing - namespace objects and bare globals alike. One occurrence,
     * one classification: an access on it is a member reference, and only the
     * absence of an access makes it a name-level read. */
    for (const hit of masked.matchAll(ROOT_READ)) {
      const name = hit[1];
      if (BROWSER_GLOBALS.has(name)) continue;
      const start = hit.index;
      const end = start + hit[0].length;
      if (/^\s*=(?!=)/.test(masked.slice(end, end + 8))) continue; // the publication itself
      const acc = accessOn(masked, end);
      if (acc.kind === "none" || acc.kind === "call") {
        check(name, null, name, "global");
        const escape = escapeOf(masked, start, end, claimed, acc);
        if (escape) unresolvable.push(rel + ": " + name + " is " + escape + ", so its members are not checked here");
        continue;
      }
      chain(name, readAccess(name, acc, name, "direct"), acc, name);
    }

    /* root[expr] - the NAMESPACE named by a value rather than by syntax, which
     * is a rung below a computed member read: not even the namespace is known.
     * Nothing resolves it, so the whole reference has to be visible instead. */
    for (const hit of masked.matchAll(new RegExp(NS_ROOT + "\\s*(?:\\?\\.)?\\[", "g"))) {
      const close = matchingClose(masked, hit.index + hit[0].length - 1);
      const text = masked.slice(hit.index, close === null ? hit.index + 24 : close + 1);
      unresolvable.push(
        rel + ": a namespace read off the global object by expression, not by name: " +
          JSON.stringify(text.replace(/\s+/g, " "))
      );
    }

    // const { name, name } = root
    for (const segments of fromGlobal.values()) {
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
    for (const { ns, segments } of destructures.values()) {
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

    /* ALIAS.member, in whatever syntax the access is written - and the same
     * escape check the direct form gets, because `f(root.RANs)` and `const S =
     * root.RANs; f(S)` hand the namespace across the same boundary. */
    for (const [local, ns] of aliases) {
      for (const hit of masked.matchAll(new RegExp("(?<![.\\w$])" + local + "(?![\\w$])", "g"))) {
        const end = hit.index + local.length;
        const acc = accessOn(masked, end);
        const reference = local + "  (" + local + " = " + ns + ")";
        if (acc.kind === "none" || acc.kind === "call") {
          const escape = escapeOf(masked, hit.index, end, claimed, acc);
          if (escape) unresolvable.push(rel + ": " + reference + " is " + escape + ", so its members are not checked here");
          continue;
        }
        chain(ns, readAccess(ns, acc, reference, "alias"), acc, reference);
      }
    }

    // THUNK().member
    for (const [local, ns] of thunks) {
      for (const hit of masked.matchAll(new RegExp("(?<![.\\w$])" + local + "(?![\\w$])", "g"))) {
        // `function store() { return root.RANs; }` is the thunk being declared,
        // not called: its `()` belongs to the parameter list.
        if (wordBefore(masked, hit.index) === "function") continue;
        const called = callEnd(masked, hit.index + local.length);
        if (called === null) continue; // the declaration, the export, `const x = T()`
        const reference = local + "()  (" + local + " = () => " + ns + ")";
        const acc = accessOn(masked, called);
        chain(ns, readAccess(ns, acc, reference, "thunk"), acc, reference);
      }
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

/* Set just under what the repo resolves today, per FORM, because a single total
 * cannot tell "the alias idiom moved to the thunk idiom" from "the alias idiom
 * stopped being read". Live counts: direct 109, alias 165, thunk 60,
 * destructure 97 - 431 member references - and 107 name-level reads.
 *
 * MEMBER floors and NAME floors are kept apart on purpose. `global` counts
 * name-level reads - "something publishes this name" - and the other four count
 * member-level ones - "that namespace publishes this key". The optional-chaining
 * round was won by turning member reads into name-level ones: the member forms
 * fell, `global` rose to match, and a combined total noticed nothing. A member
 * count can therefore never be propped up by a name count again.
 *
 * Raise them as coverage grows, and read a DROP as the finding it is:
 *   - one member form down and another up, member total steady, is consumers
 *     moving between idioms. Nothing is lost; re-pin both numbers.
 *   - the MEMBER TOTAL down means member references left the relation. Either
 *     the resolver stopped reading a form it used to read, or consumers moved to
 *     one it never read. Lowering the floor is not the fix. */
const MEMBER_FLOORS = { direct: 105, alias: 160, thunk: 58, destructure: 95 };
const MEMBER_TOTAL_FLOOR = 425;
const NAME_FLOOR = 100;

test("every reference form is still being resolved in the numbers the repo has", () => {
  const memberTotal = Object.entries(counts)
    .filter(([form]) => form !== "global")
    .reduce((n, [, c]) => n + c, 0);
  const dropped = Object.entries(MEMBER_FLOORS)
    .filter(([form, floor]) => counts[form] < floor)
    .map(([form, floor]) => form + ": " + counts[form] + " resolved, floor is " + floor);
  assert.deepEqual(
    dropped,
    [],
    "a reference form is being resolved less than it was:\n  " + dropped.join("\n  ") +
      "\n  (all forms: " + JSON.stringify(counts) + ", member total " + memberTotal + ")" +
      "\n  If consumers moved from one form to another the member total holds and the other form rose;" +
      "\n  re-pin both numbers. If the member total fell, references stopped being checked - find out why."
  );
  assert.ok(
    memberTotal >= MEMBER_TOTAL_FLOOR,
    "only " + memberTotal + " MEMBER references resolved, floor is " + MEMBER_TOTAL_FLOOR + " - " +
      JSON.stringify(counts) + ". Member references have left the relation, which is what happens when " +
      "consumers move to a form this file does not read. A rise in `global` is not compensation: that " +
      "counts names, not members."
  );
  assert.ok(
    counts.global >= NAME_FLOOR,
    "only " + counts.global + " name-level reads resolved, floor is " + NAME_FLOOR
  );
});

test("the references that cannot be resolved statically are these, and only these", () => {
  /* Listed rather than dropped. Each one is a namespace-valued expression the
   * scan SEES but cannot decide, and leaving them implicit would let the set
   * grow until the guard covers nothing. A new entry here is a prompt to either
   * teach the resolver the form or accept it in writing, here, with a reason.
   *
   * The first two entries are the extension's one dependency-injection seam,
   * and they are here rather than in prose because prose does not fail when a
   * third one appears. `createReplayStore({ idb: RATrackerIdb })` hands the
   * whole namespace across a call boundary, and every later `idb.put(...)` in
   * store/replay-store.js is a member read on a PARAMETER, which no name
   * resolution can follow. That seam is pinned behaviourally instead - see the
   * test below - and a third injection site would need the same treatment.
   *
   * What else would land here, and what each means:
   *   - a computed member read (`NS[key]`), whose key is not a literal;
   *   - a member access written in a syntax `accessorAt` cannot read;
   *   - a rest element in a destructure, which names no members;
   *   - a local that is a namespace alias in one place and something else in
   *     another, which cannot be told apart by name;
   *   - a namespace bound, returned or stored by an expression `namespaceValue`
   *     cannot decide - the arrow-thunk hole, had this net existed when it
   *     opened.
   *
   * The third entry is the viewer's boot check, `REQUIRED.filter((name) =>
   * !root[name])`. The names it looks for are STRINGS, which the masker blanks
   * before any of this runs, so the namespace itself is unknown here - a rung
   * below a computed member read, where at least the namespace has a name. It
   * is listed rather than described so that a consumer moving to a string-keyed
   * lookup has to come through this assertion.
   *
   * And the boundary of the claim, stated plainly, because two rounds have
   * overclaimed it. This list is total for namespace values THIS SCAN SEES. It
   * is not total for the extension:
   *   - a namespace that escapes into a parameter is named here, but what the
   *     CALLEE then does with it is invisible; that is the seam above.
   *   - a value that both flows through an expression this reader cannot decide
   *     AND is handed onward in the same breath (`f(cond ? NS : other)`) is
   *     reported at the point it escapes, not at the point it was chosen.
   *   - a namespace reached through neither `root.` nor a local bound from one
   *     - through `this`, say, or an import - is not modelled at all. Nothing
   *     in the extension does that today; the member floors are what would
   *     notice consumers moving there wholesale. */
  assert.deepEqual(unresolvable, [
    "background.js: RATrackerIdb is a property of an object, so its members are not checked here",
    "dashboard/legacy.js: RATrackerIdb is a property of an object, so its members are not checked here",
    'share/worker/public/viewer.js: a namespace read off the global object by expression, not by name: "root[name]"',
  ]);
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
    /* The optional-chaining round. `?.` is not a rule of its own anywhere in
     * this file - `accessorAt` treats `?.` and `.` as one access because they
     * ARE one access - and these cases exist to keep it that way. */
    "optional direct member": 'root.RAThing?.wrong("x");',
    "optional aliased member": "const T = root.RAThing;\nT?.wrong();",
    "optional through a thunk": "const T = () => root.RAThing;\nT()?.wrong();",
    "optionally called thunk": "const T = () => root.RAThing;\nT?.().wrong();",
    "optional after a fallback": 'const v = (root.RAThing || require("./a.js"))?.wrong;',
    // Bindings that arrive by a route the older versions had no regex for.
    "through a ?? fallback": "const T = root.RAThing ?? {};\nT.wrong();",
    "through a function thunk": "function T() { return root.RAThing; }\nT().wrong();",
    "through an arrow body thunk": "const T = () => { return root.RAThing; };\nT().wrong();",
    "destructured through ??": "const { wrong } = root.RAThing ?? {};",
    "destructured through a conditional": "const { wrong } = flag ? root.RAThing : root.RAThing;",
  };

  for (const [shape, publish] of Object.entries(publications)) {
    for (const [form, use] of Object.entries(references)) {
      const where = shape + " / " + form;
      assert.deepEqual(scan({ "a.js": publish, "b.js": use }).shapeErrors, [], where);
      assert.equal(scan({ "a.js": publish, "b.js": use }).problems.length, 1, where + " must report the rename");
      const good = use.replace(/wrong/g, "wanted");
      const clean = scan({ "a.js": publish, "b.js": good });
      assert.deepEqual(clean.problems, [], where + " must stay silent when correct");
      // A form the resolver READS must not also be reported as one it cannot:
      // a guard that names every reference names nothing.
      assert.deepEqual(clean.unresolvable, [], where + " must not be reported as unresolvable");
    }
  }
});

test("a member access nobody taught this file to read is reported, not counted as a bare name", () => {
  /* The regression test for the structural bug behind all three defeats. Every
   * case here reads a MEMBER off a namespace in a syntax the resolver does not
   * turn into a name; not one of them may pass as a name-level read.
   *
   * The check is `unresolvable`, not `problems`: these cannot be resolved to a
   * key, and the requirement is that they are VISIBLE. If a future syntax is
   * added to `accessorAt`, the matching case here moves from this test to the
   * one above - which is the intended direction of travel. */
  const publish = "root.RAThing = { wanted };\n";
  const hidden = {
    "computed with a literal": 'root.RAThing["wanted"]();',
    "computed with a variable": "root.RAThing[key]();",
    "optionally computed": "root.RAThing?.[key]();",
    "computed off an alias": "const T = root.RAThing;\nT[key]();",
    "computed off a thunk": "const T = () => root.RAThing;\nT()[key]();",
    "computed through a fallback": 'const v = (root.RAThing || require("./a.js"))[key];',
  };
  for (const [form, use] of Object.entries(hidden)) {
    const got = scan({ "a.js": publish, "b.js": use });
    assert.deepEqual(got.problems, [], form + " cannot be resolved, so it must not be reported as a problem");
    assert.equal(got.unresolvable.length, 1, form + " must be named in unresolvable, not counted: " + use);
    /* And it must count as no member reference at all. The name-level count may
     * be 1 where the case binds an alias first - that read really is a name
     * read - but nothing here may be mistaken for a checked MEMBER. */
    const members = Object.entries(got.counts)
      .filter(([name]) => name !== "global")
      .reduce((n, [, c]) => n + c, 0);
    assert.equal(members, 0, "an unreadable member access must count as no member reference: " + use);
  }

  // The direct cases carry no binding, so they must count as nothing whatever.
  for (const use of ['root.RAThing["wanted"]();', "root.RAThing?.[key]();"]) {
    const got = scan({ "a.js": publish, "b.js": use });
    assert.equal(Object.values(got.counts).reduce((a, b) => a + b, 0), 0, "must count as nothing: " + use);
  }
});

test("an access syntax this file was never taught is reported, not absorbed", () => {
  /* The property the whole design exists for, tested directly rather than
   * inferred. None of these is an accessor `accessorAt` knows; every one of
   * them must still be seen as an access and reported, because none of them is
   * a terminator either. Three previous rounds died of the opposite - an
   * unknown access syntax being read as "no access here". */
  const publish = "root.RAThing = { wanted };\n";
  const unknown = {
    "a non-null assertion": "root.RAThing!.wanted();",
    "a bind operator": "root.RAThing::wanted;",
    "a private name": "root.RAThing.#wanted;",
  };
  for (const [form, use] of Object.entries(unknown)) {
    const got = scan({ "a.js": publish, "b.js": use });
    assert.equal(got.unresolvable.length, 1, form + " must be named in unresolvable: " + use);
    assert.match(got.unresolvable[0], /cannot read/, form);
    assert.equal(got.counts.global, 0, form + " must not be counted as a name-level read");
  }

  /* And the counterfactual for the syntax that actually beat the last version,
   * stated as the fact that makes it hold: `?.` is not in the terminator set.
   * Take the two `\?\.` branches out of ACCESSOR_AT - put this file back to
   * having never heard of optional chaining - and `NS?.member` still cannot be
   * classified as "the value ends here". It would land in `unreadable` and
   * fail, which is what "the next shape announces itself" means. */
  for (const optional of ["?.writeShares(x)", "?.[key]", "?.(x)"]) {
    TERMINATOR_AT.lastIndex = 0;
    assert.equal(
      TERMINATOR_AT.exec(optional),
      null,
      "`" + optional + "` must never read as the end of a value, taught or not"
    );
  }
});

test("a namespace that escapes this file's names is named, not counted", () => {
  /* The other half of the closed bottom. A namespace value that no member is
   * read off is only harmless if it stays inside its expression. Once it moves
   * - into an argument, a property, an array, a return, or a binding the
   * resolver could not read - members can be read off it somewhere no name
   * resolution reaches, so it has to be visible. */
  const publish = "root.RAThing = { wanted };\nroot.RAOther = { wanted };\n";
  const escapes = {
    "passed as an argument": "makeStore(root.RAThing);",
    "handed over as a property": "makeStore({ idb: root.RAThing });",
    "put in an array": "const all = [root.RAThing];",
    "returned from a function": "function pick(flag) { if (flag) return root.RAThing; return null; }",
    "bound to an object field": "state.thing = root.RAThing;",
    "bound to two different namespaces": "const T = flag ? root.RAThing : root.RAOther;",
    "bound by a second declarator": "const other = 1, T = root.RAThing;\nT.wanted();",
    "assigned after being declared": "let T;\nT = root.RAThing;\nT.wanted();",
    "named by a string, not by syntax": 'root["RAThing"].wanted();',
    // Aliasing it first must not launder it: same boundary, same report.
    "aliased, then passed as an argument": "const T = root.RAThing;\nmakeStore(T);",
    "aliased, then handed over as a property": "const T = root.RAThing;\nmakeStore({ idb: T });",
  };
  for (const [form, use] of Object.entries(escapes)) {
    const got = scan({ "a.js": publish, "b.js": use });
    assert.deepEqual(got.problems, [], form + " is not a broken reference, only an unfollowable one");
    assert.equal(got.unresolvable.length, 1, form + " must be named in unresolvable: " + use);
  }

  /* And the reads that stay put are NOT reported - a guard that names every
   * mention of a namespace names nothing. */
  const quiet = {
    "tested for presence": "if (root.RAThing) run();",
    "guarded with &&": "root.RAThing && root.RAThing.wanted();",
    "used as a condition": "const v = { x: root.RAThing ? 1 : 2 };",
    "type-checked": 'if (typeof root.RAThing !== "object") return;',
    // The `=` of `===` is not the `=` of an assignment.
    "compared for identity": "if (thing === root.RAThing) run();",
    "compared the other way": "if (root.RAThing !== thing) run();",
    "called": "root.RAThing.wanted(1);",
    "bound to a local": "const T = root.RAThing;\nT.wanted();",
    "bound through a fallback": 'const T = root.RAThing || require("./a.js");\nT.wanted();',
    "deferred to by a thunk": "const T = () => root.RAThing;\nT().wanted();",
    "mirrored for CommonJS": "module.exports = root.RAThing;",
  };
  for (const [form, use] of Object.entries(quiet)) {
    const got = scan({ "a.js": publish, "b.js": use });
    assert.deepEqual(got.unresolvable, [], form + " must not be reported: " + use);
    assert.deepEqual(got.problems, [], form + " must not be a problem: " + use);
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
    "optionally, off the namespace itself": "root.RANotify?.dialog()?.wrong();",
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
    // The modernisation of that last line, and the shape the audit used to put
    // RATPageUI.reportStorageFailure to sleep. It is a CALL on the name, not a
    // member read, and it stays a name-level check.
    "optionally called": "root.RAToast?.(message);",
  };
  for (const [form, use] of Object.entries(uses)) {
    assert.deepEqual(scan({ "a.js": publish, "b.js": use }).problems, [], form + " must resolve");
    const renamed = publish.replace("extractCssAssets", "extractCssAssetsV2").replace("RAToast", "RAToastV2");
    assert.equal(scan({ "a.js": renamed, "b.js": use }).problems.length, 1, form + " must report the rename");
  }

  // A member read off a name published as a bare function cannot be checked, and
  // says so rather than passing - in either access syntax.
  for (const use of ["root.RAToast.dismiss();", "root.RAToast?.dismiss();"]) {
    const opaque = scan({ "a.js": publish, "b.js": use });
    assert.equal(opaque.problems.length, 1, use);
    assert.match(opaque.problems[0], /publishes it as the value of/);
  }

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
    "const maybe = root.RAThing?.pick();\n" +
    "PANEL.open();\n" +
    "SHARE_PANEL.setShare();\n" +
    "found.name;\n" +
    "maybe.name;\n";
  assert.deepEqual(scan({ "a.js": publish, "b.js": consume }).problems, []);
  assert.deepEqual(scan({ "a.js": publish, "b.js": consume }).unresolvable, []);

  // ...and the two aliases really are being checked, not merely ignored.
  const swapped = consume.replace("SHARE_PANEL.setShare()", "SHARE_PANEL.open()");
  assert.equal(scan({ "a.js": publish, "b.js": swapped }).problems.length, 1);
});
