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
 * Six audits have defeated six versions of this guard. The first five each
 * wrote a reference in a syntax the previous version did not enumerate; the
 * sixth wrote no reference at all, and is the interesting one:
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
 *   4. nothing - (3) was fixed properly, by inverting the enumeration on the
 *      ACCESS side, and the fix held.
 *   5. THE DOOR RATHER THAN THE ROOM. `const { RATrackerStorage } = window;`,
 *      and `window\n  .RATrackerStorage.writeShares(...)`, and
 *      `{ ...root.RAThing }`. The access side was closed, so the audit stopped
 *      attacking it and attacked what counts as a namespace value in the first
 *      place. Renaming `writeShares` afterwards passed 809/809 with both
 *      production consumers calling `undefined`.
 *   6. THE LEXER, which is upstream of all three closed lists below.
 *      `maskLiterals` decided regex-from-division by the last non-space
 *      CHARACTER, so any `/` after a word character read as division - and
 *      `return /[",\n]/.test(s) ? ...`, which dashboard/bundle.js:112 has
 *      carried all along, is a regex after a keyword. Read as division, the `"`
 *      inside it opened a STRING, and everything to the next matching quote was
 *      blanked: 164 characters over lines 112-126, `function parseBundle`
 *      included. Two edits then took the guard - rename `defer` on
 *      RATrackerDialog, and copy that same one-line helper into
 *      dashboard/legacy.js some twenty lines above `dlg.defer(load)`. Both are
 *      valid JavaScript and both look ordinary. `problems` stayed empty,
 *      `unresolvable` byte-identical, every floor held, 811/811 green, and
 *      `dlg.defer(load)` called a function that no longer existed. Copied into
 *      other dashboard files the same helper drops references at 331 insertion
 *      points in view-matches.js and 178 in legacy.js, up to 31 at a stroke; a
 *      big drop trips the floors, but the two-edit version fits in their slack.
 *
 * The first five are one bug in two places. The resolver was a set of regexes
 * for enumerated syntaxes with an OPEN BOTTOM: something that no pattern matched
 * fell through to a cheaper check, or to nothing at all, and was counted as
 * RESOLVED either way. An unread syntax therefore did not merely vanish - it was
 * reported as coverage, which is why every floor stayed satisfied while the
 * members went unchecked.
 *
 * The sixth is NOT that bug. Nothing fell through an enumeration, because
 * nothing arrived: the code was gone before entry, access or propagation ran.
 * Deletion is the one failure a closed list cannot report - a list classifies
 * what it is shown, and it was not shown anything - so no amount of further
 * closing downstream would have caught it. What made it possible is plainer than
 * a missing syntax: the masker is the stage every other stage depends on, it had
 * a private character-level copy of a rule the rest of the file already stated
 * properly for `(`, and it was the one stage with no test of its own. Every
 * proof this file was proudest of sat below it.
 *
 * So the masker now asks `startsExpression` - the same rule `opensGroup` asks of
 * `(`, one rule in one place rather than two copies free to drift - and it is
 * built so that a misreading cannot delete: a regex body is blanked as a regex
 * body, where a quote is just a character, and a quote with no partner before
 * the end of its line is not a string opener at all. Nothing that is GUESSED at
 * can blank a newline away, so the worst any future misreading here can cost is
 * the rest of one line, and that shows up as a reference which fails to resolve
 * rather than one which was never seen. `maskLiterals` has its own tests now,
 * both synthetic and over all 62 shipped files.
 *
 * The shape of the rest is not "one more syntax" either. It is that the same
 * inversion is applied at all three places a value can be lost:
 *
 *   a. ACCESS. Whether there IS a member access on a namespace value is decided
 *      SEPARATELY from whether that access can be read, and it is decided by
 *      enumerating the OTHER side. `accessorAt` reads the accessors it knows;
 *      everything else it checks against TERMINATOR_AT, the closed list of
 *      operators and separators that can mean "this value ends here". A token
 *      that is neither is an access this file cannot read, and `readAccess`
 *      sends it to `unresolvable`. There is no path at all from "followed by
 *      something unrecognised" to "counted as a name-level read", which is what
 *      makes the NEXT unknown syntax announce itself: `?.` is not a terminator,
 *      so it would have failed here even before anyone taught this file what
 *      optional chaining is.
 *   b. ENTRY. A namespace value can only come from a read off the global
 *      object - there is no import here - so every occurrence of a name that
 *      MEANS the global object is found first (`ROOT_TOKEN`), and only then
 *      asked what is being done with it. Five answers, closed: the name is being
 *      bound rather than read; a known accessor names a namespace; a computed
 *      accessor does not; nothing readable follows and nothing that ends the
 *      value either; or the global object itself is the value. The last three
 *      report. No regex decides whether something is a door.
 *   c. PROPAGATION. A namespace value that nobody reads a member off is
 *      classified by what BECOMES of it, from closed lists on both sides: the
 *      operator in front either uses it up or hands it on, and the value is
 *      followed - out through grouping parens, not stopped by them - until
 *      something in a closed list accounts for it. Used up where it stands, or
 *      claimed by a binding the resolver read: nothing more to check. Passed as
 *      an argument, stored in an object or an array, returned, or landing inside
 *      a binding no binding here claimed: reported. `namespaceValue` failing to
 *      decide an expression is therefore no longer a way out - the read it did
 *      not claim is still followed, and still ends up somewhere that reports.
 *   d. The name-level count is floored SEPARATELY from the member-level ones and
 *      excluded from their total, because it is a different check. It was the
 *      bucket the degraded member reads fell into, and a bucket that grows when
 *      member checks are lost cannot also be what proves they are not.
 *
 * WHAT IS GUARANTEED, stated to match the code and no wider, because a claim
 * ahead of the code is the defect that keeps recurring here - and the previous
 * wording was exactly that. It said "every mention of the global object in a
 * scanned file", which is a claim about the FILES, and the scan does not read
 * files: it reads what the masker leaves standing. Every character the masker
 * blanked was outside the claim while appearing to be inside it, and that gap is
 * where the sixth defeat lived. So the subject of the sentence is now the text
 * the scan actually sees:
 *
 *   IN THE CODE THE MASKER LEAVES STANDING - every shipped .js file with its
 *   comment bodies, string bodies, regex bodies and template TEXT blanked (the
 *   masker's own tests check, over all 62 files, that it blanks only, preserves
 *   every offset and newline, leaves balanced brackets, and leaves output that
 *   still PARSES - the last of which is what would catch a span of real code
 *   going missing) - every mention of the global object and every mention of
 *   a local this file bound to a namespace or to the global object is classified
 *   exactly once, into one of: the name being BOUND rather than read (a
 *   parameter, an object key - not a read at all), a RESOLVED check against what
 *   the other file publishes, or a line in `unresolvable`. So: no member access
 *   on such a value is silently dropped, and no such value is bound, stored,
 *   passed or returned - directly, through an alias, or through a thunk and its
 *   call - without either being followed to another name this file tracks or
 *   being named in that list.
 *
 * What that does NOT claim, all of which is real:
 *   - it says nothing about what a CALLEE does with a namespace handed to it.
 *     Those hand-overs are named in `unresolvable` (the idb injection, the three
 *     global-object hand-overs) and the idb one is pinned behaviourally instead.
 *   - it says nothing about namespaces reached by neither route - through
 *     `this`, or an import, or a name this file never saw bound. Nothing in the
 *     extension does that today, and the member floors are what would notice a
 *     wholesale move.
 *   - `unresolvable` is total for what the scan SEES. It is not a claim that
 *     nothing else exists, and the list is the place to argue about that.
 *   - IT IS NOT A CLAIM ABOUT THE MASKER BEING RIGHT. A reference the masker
 *     blanks is outside the guarantee, not covered by it. What is claimed of the
 *     masker is narrower and is tested rather than asserted: it only ever blanks
 *     characters, never rewrites or moves them; it preserves every newline, so
 *     line numbers hold; the code it leaves has balanced brackets in all 62
 *     files; and it still parses in all 62.
 *
 *     Its two guessing rules are bounded UNEQUALLY, and the difference matters.
 *     The string rule is hard-bounded: a quote with no partner before the line
 *     ends opens nothing, so being wrong there costs at most the rest of one
 *     line. The regex-or-division rule is NOT so bounded. A misread `/` closes
 *     on the next `/`, and if the text between them contains a backtick it can
 *     take the opening backtick of a template with it, promoting the closing
 *     one to an opener and blanking several lines - brackets still balanced,
 *     nothing reported. Reaching it needs a division whose left operand ends in
 *     a token spelled like one of the expression keywords; the tree has none
 *     today, and the parse check below is what makes it loud rather than silent
 *     if one ever arrives. So: a misreading is USUALLY a reference that fails
 *     to resolve, and the parse check is what stands behind the exception.
 *     Deliberately
 *     outside: a `root.RAThing` written inside a comment or a string is not a
 *     reference and is not counted as one.
 *   - the publication of a thunk is followed rather than reported
 *     (`publishedThunkValues`), because `readPublished` records what it defers
 *     to and consumers resolve through that record. A thunk that leaves the file
 *     any OTHER way is an escape and is named.
 * The four known limits above are the whole of it; each is checked or listed
 * below rather than left to prose.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
 * inside a template), hence the stack rather than a flag.
 *
 * THE MASKER IS UPSTREAM OF EVERY OTHER CHECK IN THIS FILE, which is why the
 * regex/division decision below is made from the last TOKEN and not, as it was,
 * from the last non-space CHARACTER. The sixth audit went through exactly there.
 * `return /[",\n]/.test(s) ? ...` - dashboard/bundle.js:112, live in the repo -
 * has a `/` after the `n` of `return`, and a character-level rule reads any `/`
 * after a word character as division. The regex was then not a regex, its `"`
 * opened a STRING, and everything to the next quote was blanked: 164 characters
 * of real code on lines 112-126, `function parseBundle` among them, gone before
 * entry, access or propagation ever ran.
 *
 * That failure mode is DELETION, and deletion is the one thing none of the three
 * closed lists downstream can report: they classify what they are shown, and
 * they were not shown it. So the decision is made once, by `startsExpression`,
 * which is the same rule `opensGroup` already applies to `(` - a value has
 * ended, or an expression begins - rather than a second copy free to diverge
 * from it. Two tests below hold it to that: one over written-out cases, one over
 * all 62 shipped files. */
function maskLiterals(source) {
  const out = source.split("");
  const n = source.length;
  let i = 0;
  /* The last TOKEN, as `startsExpression` wants it: an identifier or keyword as
   * written, a punctuator as written, LITERAL_TOKEN for a string, template or
   * regex that just ended, and "" at the start of the file. */
  let prev = "";
  /* The token in front of each `(` still open, so a `)` can be told from the `)`
   * of `if (...)`, after which a `/` starts a regex rather than dividing. */
  const parens = [];
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
        prev = LITERAL_TOKEN;
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
      /* A quoted string does not cross a line in JavaScript, so a quote with no
       * partner before the newline is NOT a string opener - and refusing to
       * treat it as one is what bounds the damage of any misreading here.
       *
       * That is the second half of the lexer fix, and the half that matters
       * most. A `/` misread as division put a quote from inside a regex into
       * code position; the quote then opened a string that ran to the next
       * quote FIFTEEN LINES LATER, and everything between was blanked. Deletion
       * at that scale is invisible to every check downstream, which can only
       * classify what it is shown. With this, a misreading of any kind can cost
       * at most the rest of one line, because nothing except a block comment or
       * a template literal - both of which are delimited, not guessed - can
       * blank a newline away. */
      let j = i + 1;
      while (j < n && source[j] !== "\n") {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === c) break;
        j++;
      }
      if (source[j] !== c) {
        // An unpartnered quote: read it as the stray character it is, blank nothing.
        prev = c;
        i++;
        continue;
      }
      for (let k = i + 1; k < j; k++) blank(k);
      i = j + 1;
      prev = LITERAL_TOKEN;
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
    /* A `/` after a value is division; where an expression begins it opens a
     * regex, and only that case needs blanking. The decision is the last TOKEN's
     * - `return /re/` is a regex and `count / 2` is not - and it is
     * `startsExpression` that says so, the same rule `opensGroup` asks of `(`.
     *
     * The body is then read as a regex body and NOTHING ELSE: a `"` in it is one
     * more character to blank, never the start of a string, and a `/` inside a
     * `[...]` class does not end it. That is the whole of why a mis-lex here can
     * no longer delete code past the literal - it can only misread the literal
     * itself. */
    if (c === "/" && startsExpression(prev)) {
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
        while (i < n && /[a-z]/.test(source[i])) i++; // flags
        prev = LITERAL_TOKEN;
        continue;
      }
      /* No closing `/` before the line ended, so it was not a regex after all.
       * The line is re-read as ordinary code rather than blanked to its end:
       * being wrong about one operator is a local misreading, and blanking is
       * the failure this whole decision exists to prevent. */
      i = start;
    }

    // An identifier, a keyword or a number: one token, however many characters.
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(source[j])) j++;
      prev = source.slice(i, j);
      i = j;
      continue;
    }
    if (c === "(") {
      parens.push(prev);
      prev = "(";
    } else if (c === ")") {
      /* `if (ok) /re/.test(s)`: the `)` of a statement head closes a test, not a
       * value, so an expression - and a regex - can begin right after it. */
      const head = parens.length ? parens.pop() : "";
      prev = STATEMENT_KEYWORDS.has(head) ? head : ")";
    } else if ((c === "+" || c === "-") && prev === c) {
      prev = c + c; // `n++ / 2` divides
    } else if (!/\s/.test(c)) {
      prev = c;
    }
    i++;
  }
  return out.join("");
}

/* A string, template or regex literal that just ended, reported as one token
 * whatever its spelling was: what matters downstream is only that a VALUE ended
 * there. It is not a substring of any source token, so it can never be confused
 * with one. */
const LITERAL_TOKEN = "<literal>";

/* The value ends, or an expression begins - and the two `/` and `(` questions
 * this file asks are the same question.
 *
 * An expression begins at the start of the file, after an operator, after a
 * separator or an opener, and after a keyword that takes an expression
 * (EXPRESSION_KEYWORDS). A value has just ended after an identifier, after a
 * literal, after `)` or `]`, and after `++`/`--`. There is no third answer: a
 * `/` where an expression begins is a regex and one after a value is division,
 * and a `(` where an expression begins groups while one after a value calls.
 *
 * `maskLiterals` asks it of the token it just read; `opensGroup` asks it of the
 * token before a `(`. One rule, so the masker cannot drift from the reader that
 * depends on it - which is exactly how the sixth defeat became possible, the
 * masker having had a private character-level copy of it. */
const VALUE_ENDS = new Set([")", "]", "++", "--"]);

function startsExpression(token) {
  if (token === "") return true;
  if (token === LITERAL_TOKEN) return false;
  if (/^[\w$]/.test(token)) return EXPRESSION_KEYWORDS.has(token);
  return !VALUE_ENDS.has(token);
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
  return startsExpression(wordBefore(masked, open));
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
 * Entering: every mention of the global object, classified
 * ------------------------------------------------------------------ */

/* THE CLOSED BOTTOM ON THE ENTRY SIDE - the door, rather than the room.
 *
 * A namespace value gets into this extension exactly one way: something reads a
 * name off the global object. There is no import and no module scope, so
 * `<the global object>.<name>` is the only door, and every namespace value
 * anywhere is that read or a copy of one.
 *
 * Which makes the door the same enumeration problem the access side had, and
 * the fifth audit won on exactly that. The door used to be a regex - one of the
 * four root names followed IMMEDIATELY by a dot - and everything that regex did
 * not match was not "an entry I cannot read", it was nothing at all:
 *
 *   window\n  .RATrackerStorage.writeShares(x)   - a newline before the dot
 *   const { RATrackerStorage } = window;         - a door with no dot in it
 *   (typeof window !== "undefined" ? window : globalThis).RATBoard
 *   { ...root.RAThing }                          - the `.` of the spread made
 *                                                  the read look like `x.root`
 *
 * all read as nothing at all, so the members taken off them afterwards were
 * checked nowhere and renaming the key stayed green.
 *
 * So the door is enumerated from the other side too. `ROOT_TOKEN` finds every
 * occurrence of a name that MEANS the global object, and only then is it asked
 * what is being done with that occurrence. The answers are a closed set:
 *
 *   - the name is being BOUND, not read (a parameter, an object-literal key, a
 *     declaration). `bindsTheName` decides this, and a declaration is reported,
 *     because it would make every later read in the file mean something else.
 *   - a known accessor follows, naming a namespace: the ordinary read, in
 *     whatever syntax and across whatever whitespace or comment, because the
 *     accessor machinery is shared with the access side.
 *   - a computed accessor follows (`root[name]`): the namespace itself is not
 *     known, and it is reported.
 *   - nothing readable follows, and nothing that ENDS the value either: an
 *     entry syntax this file cannot read, reported.
 *   - the value ends: the global object itself is the value, and where it goes
 *     is `dispositionOf`'s question.
 *
 * There is no fall-through. A root token is one of those five, and the two that
 * mean "I cannot follow this" both report. */

const ROOT_NAMES = new Set(["root", "window", "globalThis", "self"]);
const ROOT_TOKEN = /(?<![\w$])(?:root|window|globalThis|self)(?![\w$])/g;
const ROOT_TOKEN_AT = /(?:root|window|globalThis|self)(?![\w$])/y;
const IDENT_AT = /[A-Za-z_$][\w$]*/y;

/* `out.self.endTurn` in dashboard/analysis.js is a field of a tally called
 * `self`, not the global object. But `{ ...root.RAThing }` IS a read of the
 * global object and there is a dot in front of THAT too - it belongs to the
 * spread. The old `(?<![.\w$])` guard could not tell them apart and rejected
 * both, which is why a spread was not merely unread but unseen. */
function isMemberName(masked, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(masked[i])) i--;
  if (i < 0 || masked[i] !== ".") return false;
  return !(masked[i - 1] === "." && masked[i - 2] === ".");
}

/** The operator a value sits behind, as written: `===`, `||`, `=>`, `(`, `,`. */
function operatorBefore(masked, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(masked[i])) i--;
  if (i < 0) return "";
  if (/[\w$]/.test(masked[i])) return wordBefore(masked, at);
  if (!/[=!<>+\-*/%&|^~?:]/.test(masked[i])) return masked[i]; // a bracket, a comma, a spread's dot
  let j = i;
  while (j >= 0 && /[=!<>+\-*/%&|^~?:]/.test(masked[j])) j--;
  return masked.slice(j + 1, i + 1);
}

/** A `(` that opens a parameter list rather than a call's arguments. */
function opensParameterList(masked, open) {
  if (masked[open] !== "(") return false;
  const close = matchingClose(masked, open);
  if (close !== null && /^\s*=>/.test(masked.slice(close + 1, close + 6))) return true;
  const head = masked.slice(Math.max(0, open - 64), open);
  return /\bfunction\s*(?:[A-Za-z_$][\w$]*\s*)?$/.test(head) || /\b(?:get|set)\s+[A-Za-z_$][\w$]*\s*$/.test(head);
}

/**
 * The name being BOUND rather than the global object being read.
 *
 * `(function (root) {`, `root: '[data-testid="game-state"]'` in
 * capture/board-read.js and `self: blankSide()` in dashboard/analysis.js are all
 * the word `root`/`self` used as a name, not as the global object; counting them
 * as reads would report an object literal's own keys as escaping namespaces. A
 * `const`/`let`/`var`/`function`/`class` of one of these names is a different
 * matter - it would make every read after it mean something else - so it comes
 * back as "declaration" and the caller reports it.
 */
function bindsTheName(masked, at, end) {
  const before = operatorBefore(masked, at);
  if (["const", "let", "var", "function", "class"].includes(before)) return "declaration";
  if (/^\s*=>/.test(masked.slice(end, end + 5))) return "parameter";
  const open = enclosingOpen(masked, at);
  if (open === null) return null;
  if (masked[open] === "(" && opensParameterList(masked, open)) return "parameter";
  if (
    masked[open] === "{" &&
    opensObjectLiteral(masked, open) &&
    (before === "{" || before === ",") &&
    /^\s*:/.test(masked.slice(end, end + 4))
  ) {
    return "key";
  }
  return null;
}

/**
 * `})(typeof window !== "undefined" ? window : globalThis)` - the wrapper every
 * module in this repo ends with, and the one place the global object itself is
 * meant to cross a call boundary.
 *
 * It is not an escape, but not because it is spelled that way: it crosses into a
 * PARAMETER whose name is one of the four root names, and reads off that name
 * are scanned as reads of the global object exactly like `window.` is. The seam
 * closes because the name closes it, and this checks that the name really is one
 * of them rather than trusting the shape.
 */
function handedToModuleWrapper(masked, at) {
  const open = enclosingOpen(masked, at);
  if (open === null || masked[open] !== "(") return false;
  const head = masked.slice(0, open).trimEnd();
  if (!head.endsWith(")")) return false;
  const calleeOpen = enclosingOpen(masked, head.length - 1);
  if (calleeOpen === null) return false;
  const inner = masked.slice(calleeOpen + 1, head.length - 1);
  /* Both spellings of the wrapper. `wrapperFeeding` - the same seam checked from
   * the inside - reads the arrow form through `opensParameterList` already, so
   * matching only `function` here reported the arrow wrapper as an escape while
   * agreeing it was not one. Noise rather than silence, but a guard whose two
   * halves disagree is a guard nobody reads. */
  const m =
    /^\s*(?:async\s+)?function\s*[A-Za-z_$]*\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(inner) ||
    /^\s*(?:async\s+)?\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>/.exec(inner);
  return !!m && ROOT_NAMES.has(m[1]);
}

/**
 * ...and the same seam checked from the inside. A parameter named `root` that
 * was handed something OTHER than the global object would make every `root.RA*`
 * in that file a read of that other thing, and this whole scan would be
 * resolving references that do not exist. Returns null when the wrapper is the
 * module idiom, and a reason when it is not.
 */
function wrapperFeeding(masked, at) {
  const open = enclosingOpen(masked, at);
  if (open === null || !opensParameterList(masked, open)) return "is a parameter of a function this file cannot follow";
  const fnOpen = enclosingOpen(masked, open);
  if (fnOpen === null || masked[fnOpen] !== "(") return "is a parameter of a function that is not an immediately invoked wrapper";
  const fnClose = matchingClose(masked, fnOpen);
  if (fnClose === null || masked[fnClose + 1] !== "(") return "is a parameter of a function that is not called where it is written";
  const args = matchingClose(masked, fnClose + 1);
  if (args === null) return "is a parameter of a wrapper whose argument list does not close";
  const blank = { aliases: new Map(), thunks: new Map(), globals: new Set() };
  const value = namespaceValue(masked, fnClose + 2, args, blank);
  return value.globalObject ? null : "is a parameter of a wrapper that is handed something other than the global object";
}

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
  const t = TERMINATOR_AT.exec(masked);
  // WHICH terminator it is decides where the value goes, so it is kept:
  // `NS ===` uses the value up where it stands, `NS ||` hands it on.
  if (t) return { kind: "none", end: from, terminator: t[0].trim() };
  return { kind: "unreadable", end: from, text: masked.slice(from, from + 12).trim() };
}

/** `()` or `?.()`, the call in `THUNK().member`. */
const EMPTY_CALL_AT = /\s*(?:\?\.)?\(\s*\)/y;

function callEnd(masked, from) {
  EMPTY_CALL_AT.lastIndex = from;
  return EMPTY_CALL_AT.exec(masked) ? EMPTY_CALL_AT.lastIndex : null;
}

/* A value in parentheses is still that value: `(root.RAShare ||
 * require("./payload.js")).MAGIC` reads MAGIC off the namespace, and
 * `(typeof window !== "undefined" ? window : globalThis).RATBoard` reads a
 * namespace off the global object - the CommonJS footer thirty-five files here
 * carry, and a door the old regex could not see through at all.
 *
 * Following the value out through its grouping parens is what makes that a
 * general rule rather than the special-cased regex it used to be. It is allowed
 * only when the parenthesised expression really does hand THIS value on, which
 * `namespaceValue` decides: in the footer above, the `window` inside `typeof
 * window` is the test and not the value, and an access after the `)` is nothing
 * to do with it. A call's parentheses are excluded for the same reason -
 * `f(root.RANs).m` reads a member of what f returned. */
function accessOn(masked, from, ctx) {
  let acc = accessorAt(masked, from);
  for (let step = 0; step < 4 && acc.kind === "none"; step++) {
    const open = enclosingOpen(masked, acc.end);
    if (open === null || masked[open] !== "(" || !opensGroup(masked, open)) break;
    if (STATEMENT_KEYWORDS.has(wordBefore(masked, open))) break;
    const close = matchingClose(masked, open);
    if (close === null || close < acc.end) break;
    if (!handsOnValueAt(masked, open + 1, close, ctx)) break;
    acc = accessorAt(masked, close + 1);
  }
  return acc;
}

/** Whether the expression in `[from, to)` yields the value that starts at
 *  `ctx.start` - the one question `accessOn` needs answered to follow a value
 *  out of its parentheses. */
function handsOnValueAt(masked, from, to, ctx) {
  if (!ctx) return false;
  return offsetsOf(namespaceValue(masked, from, to, ctx.locals)).includes(ctx.start);
}

/** Every read a resolved value was built out of. */
function offsetsOf(value) {
  if (value.ats) return value.ats;
  return value.at === undefined ? [] : [value.at];
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

/** One namespace-valued result, or `unknown` when the operands disagree. Every
 *  read that went into it is carried along, because a binding that consumes the
 *  value consumes ALL of them: `flag ? root.RAThing : root.RAThing` is one
 *  binding and two reads, and the read the merge did not return is not loose. */
function mergeValues(values) {
  const ats = values.flatMap(offsetsOf);
  const puzzling = values.find((v) => v.unknown);
  if (puzzling) return { ...puzzling, ats };
  const held = values.filter((v) => v.ns || v.globalObject);
  const names = [...new Set(held.map((v) => v.ns || "the global object"))];
  if (names.length === 0) return NOTHING;
  if (names.length > 1) return { unknown: "it holds one of " + names.join(" or "), ats };
  return { ...held[0], ats };
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
 * Returns `{ ns, at }` for a namespace (with the offset of the read it consumed,
 * so the name-level pass can tell a binding it understood from one it did not),
 * `{ globalObject, at }` for the global object itself, `{ unknown }` for an
 * expression that holds a namespace by a route this cannot follow, and `NOTHING`
 * for an expression whose value is not a namespace at all.
 *
 * NOTHING is no longer a way out. Every read this function declines to bind
 * stays UNCLAIMED, and an unclaimed read that reaches a binding is reported by
 * `dispositionOf` - so an expression form nobody taught this function costs a
 * resolved reference and gains a line in `unresolvable`, rather than costing a
 * resolved reference and gaining silence. That is the difference between this
 * round and the four before it.
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

  ROOT_TOKEN_AT.lastIndex = start;
  if (ROOT_TOKEN_AT.exec(masked) && !isMemberName(masked, start)) {
    const after = ROOT_TOKEN_AT.lastIndex;
    if (after === end) return { globalObject: true, at: start };
    return offTheGlobalObject(masked, start, after, end, locals);
  }

  IDENT_AT.lastIndex = start;
  const ident = IDENT_AT.exec(masked);
  if (ident) {
    const local = ident[0];
    const after = IDENT_AT.lastIndex;
    if (locals.aliases.has(local) && after === end) return { ns: locals.aliases.get(local), at: start };
    if (locals.thunks.has(local)) {
      const called = callEnd(masked, after);
      if (called === end) return { ns: locals.thunks.get(local), at: start };
    }
    // A local holding the global object is another door into it, and the same
    // one: `const w = scheduler || root;` in share/repaint.js, then `w.RA*`.
    if (locals.globals.has(local)) return offTheGlobalObject(masked, start, after, end, locals);
  }
  return NOTHING;
}

/** What `<the global object>.<something>` is worth, the global object itself
 *  ending at `after`. */
function offTheGlobalObject(masked, start, after, end, locals) {
  const acc = accessorAt(masked, after);
  if (acc.kind !== "named") return NOTHING; // computed or unreadable: reported where it is read
  // A platform name is not ours to track: `const doc = window.document` binds
  // the document, and `doc.createElement` is nobody's cross-file reference.
  if (BROWSER_GLOBALS.has(acc.name)) return NOTHING;
  if (acc.end === end) return { ns: acc.name, at: start };
  /* Only a read that ENDS at the namespace holds one - `root.RAThing.pick()`
   * binds what pick() returned - with the one exception the repo actually uses:
   * a member that IS an exported thunk hands back the far namespace, so
   * `const d = root.RATrackerNotify.dialog();` holds RATrackerDialog. */
  const member = accessorAt(masked, acc.end);
  const entry = locals.published && locals.published.get(acc.name);
  if (member.kind === "named" && entry && entry.thunks.has(member.name)) {
    if (callEnd(masked, member.end) === end) return { ns: entry.thunks.get(member.name), at: start };
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
 * `claimed` collects the offset of every read that some binding here consumed -
 * including the reads a merged value did not return, because a binding consumes
 * all of its operands. That is what lets the name-level pass tell "bound by a
 * form the resolver reads, so its members are checked elsewhere" from "bound by
 * a form the resolver does not read, so its members are checked NOWHERE" - the
 * second being precisely how the arrow-thunk round was lost.
 *
 * `assignments` is the other half of that, and it is what closes the binding
 * side rather than enumerating it. Every `=` that binds - a declarator's
 * initialiser, an assignment to a local or a field - contributes the range of
 * the expression it binds. A read inside one of those ranges that no binding
 * claimed has been bound to a name this file is NOT tracking, whatever the
 * expression was, so `const T = (0, root.RAThing);` and `let T; T = root.RAThing;`
 * and whatever is invented next are one case, and it is reported. The resolver
 * no longer has to recognise an expression in order to notice it.
 */
function collectLocals(masked, published) {
  const locals = { aliases: new Map(), thunks: new Map(), globals: new Set(), published };
  const claimed = new Set();
  const puzzles = new Map(); //  offset -> why this binding could not be read
  const destructures = new Map(); //  offset -> { ns, segments }
  const fromGlobal = new Map(); //  offset -> segments
  const assignments = bindingRanges(masked);

  const claim = (value) => {
    for (const at of offsetsOf(value)) claimed.add(at);
  };
  const take = (value, bind) => {
    if (value.ns) {
      bind(value.ns);
      claim(value);
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
        if (value.unknown) {
          puzzles.set(from, "`" + local + "` defers to a namespace but " + value.unknown);
          claim(value);
        }
        continue;
      }
      const value = take(namespaceValue(masked, from, to, locals), (ns) => locals.aliases.set(local, ns));
      /* `const w = scheduler || root;` in share/repaint.js. A local holding the
       * global object is a door into every namespace on it, so it is tracked as
       * one rather than rediscovered at each use. */
      if (value.globalObject) {
        locals.globals.add(local);
        claim(value);
      }
      if (value.unknown) {
        puzzles.set(from, "`" + local + "` holds a namespace but " + value.unknown);
        claim(value);
      }
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
       * store/replay-store.js reads two names off the global object itself.
       *
       * Every name in such a pattern IS a namespace - that is what the global
       * object holds - so each local is bound as an alias for the namespace of
       * its own name, and `LOCAL.member` afterwards is a member reference like
       * any other. Leaving these at a name-level check is how the fifth audit
       * won: `const { RATrackerStorage } = window;` followed by
       * `RATrackerStorage.writeShares(...)` resolved the NAME, counted it, and
       * never looked at the member at all. */
      if (value.globalObject) {
        claim(value);
        fromGlobal.set(open, walked.segments);
        for (const raw of walked.segments) {
          const s = raw.trim();
          const renamed = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*$/.exec(s);
          const plain = /^([A-Za-z_$][\w$]*)\s*$/.exec(s);
          const name = renamed ? renamed[1] : plain ? plain[1] : null;
          const local = renamed ? renamed[2] : plain ? plain[1] : null;
          if (name && !BROWSER_GLOBALS.has(name)) locals.aliases.set(local, name);
        }
        continue;
      }
      if (value.unknown) {
        puzzles.set(open, "a destructure reads members of a namespace but " + value.unknown);
        claim(value);
        continue;
      }
      if (!value.ns) continue;
      claim(value);
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
    const size = locals.aliases.size + locals.thunks.size + locals.globals.size;
    readDeclarations();
    readDestructures();
    if (round > 0 && locals.aliases.size + locals.thunks.size + locals.globals.size === size) break;
  }
  return { locals, claimed, puzzles, destructures, fromGlobal, assignments };
}

/* Every `=` that BINDS: a declarator's initialiser, an assignment to a local or
 * to a field. Not `==`, `===`, `!==`, `<=`, `>=` or `=>`, and not the compound
 * assignments, whose operands are arithmetic and never a namespace.
 *
 * `module.exports = <namespace>` is marked exempt rather than left out: it is
 * the CommonJS footer every module here carries, its consumers are tests, and
 * the name it mirrors is checked like any other read. */
function bindingRanges(masked) {
  const ranges = [];
  for (const hit of masked.matchAll(/(?<![=!<>+\-*/%&|^])=(?![=>])/g)) {
    const from = hit.index + 1;
    ranges.push({
      from,
      to: initialiserEnd(masked, from),
      exempt: /module\s*\.\s*exports\s*$/.test(masked.slice(Math.max(0, hit.index - 40), hit.index)),
    });
  }
  return ranges;
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

/**
 * The object literals this file PUBLISHES, and which of their top-level values
 * are thunks declared here.
 *
 * `root.RATrackerNotify = { say, dialog }` in dashboard/notify.js hands the
 * local `dialog` - `() => root.RATrackerDialog` - out of the file, which is what
 * a publication is for; `readPublished` records it as that namespace's exported
 * thunk, and a consumer's `NOTIFY.dialog().textPrompt(...)` is resolved through
 * the record. So this one hand-over IS followed, and naming it as an escape
 * would be reporting the very thing the resolver reads.
 *
 * Both publication spellings are covered - the literal written inline and the
 * `const api = { ... }; root.RAShareUI = api;` one - because the record made
 * from them is the same. A thunk anywhere else in the literal, nested inside a
 * property's value rather than being one, is NOT in the record and NOT exempt.
 */
function publishedThunkValues(masked, locals) {
  const ranges = [];
  PUBLICATION.lastIndex = 0;
  let hit;
  while ((hit = PUBLICATION.exec(masked))) {
    const at = hit.index + hit[0].length;
    let open = at;
    if (masked[at] !== "{") {
      const ident = /^([A-Za-z_$][\w$]*)\s*;/.exec(masked.slice(at));
      if (!ident) continue;
      const decl = new RegExp("\\b(?:const|let|var)\\s+" + ident[1] + "\\s*=\\s*\\{").exec(masked);
      if (!decl) continue;
      open = masked.indexOf("{", decl.index);
    }
    const literal = objectLiteralKeys(masked, open);
    const close = matchingClose(masked, open);
    if (literal.error || close === null) continue;
    const names = new Set([...literal.values.values()].filter((name) => locals.thunks.has(name)));
    if (names.size) ranges.push({ from: open, to: close, names });
  }
  return ranges;
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

/* The operator in front of a value can only USE IT UP - the result is a boolean
 * or a number, and the namespace goes nowhere - or HAND IT ON, in which case
 * where it lands is decided further out. Both lists are closed, and an operator
 * in neither is a position this file cannot read, which is reported.
 *
 * The single characters are what `operatorBefore` returns for the WHOLE
 * operator, so `&&` and `&` are two entries meaning two different things:
 * `x && NS` may hand NS on, `x & NS` cannot. */
const CONSUMES_THE_VALUE = new Set([
  "!", "~", "typeof", "void", "delete", "case", "new", "instanceof", "in", "of",
  "+", "-", "*", "/", "%", "**", "<", ">", "<=", ">=", "==", "===", "!=", "!==",
  "&", "|", "^", "<<", ">>", ">>>",
]);
const HANDS_THE_VALUE_ON = new Set([
  "", "=", "=>", "||", "&&", "??", "?", ":", "(", ")", ",", "[", "{", "}", ";", ".",
  "const", "let", "var", "return", "else", "do", "try", "finally",
]);

/* ...and the same question on the other side, because `x === root.RAThing`
 * reaches this file as a terminator rather than as a prefix. `&&` uses up its
 * LEFT operand (`root.RAThing && root.RAThing.wanted()` is a presence test);
 * `||` and `??` do not, because the left value is the result when it is there. */
const USED_UP_BY = new Set([
  "===", "==", "!==", "!=", "<", ">", "<=", ">=", "&&", "instanceof", "in", "of",
  "+", "-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>",
]);

/**
 * What becomes of a namespace value nobody reads a member off - the name-level
 * half of the closed bottom, closed the same way round as the other two.
 *
 * A value that is used up where it stands (tested, compared, called) or that a
 * binding above consumed needs nothing further: the name itself is checked, and
 * any member read goes through a local this file tracks. A value that MOVES -
 * into an argument, an object property, an array, a return, or a binding the
 * resolver did not read - carries the namespace somewhere name resolution does
 * not follow, so it is named rather than counted.
 *
 * The difference from the version this replaces is the DEFAULT. That one
 * enumerated the escapes and let everything else mean "it stays here", so
 * `const T = (0, root.RAThing);` - a value handed out through a grouping paren
 * into a binding - was silence, and `T.writeShares(...)` afterwards was checked
 * nowhere. Here the value is followed until something in a closed list accounts
 * for it, a grouping paren is followed OUT of rather than treated as an ending,
 * and an expression that runs out without being accounted for is reported.
 */
function dispositionOf(masked, start, acc, ctx) {
  if (ctx.claimed.has(start)) return null;
  // `root.createCapturePolicy({...})` and `root.RAToast?.(message)`: what moves
  // on from here is what the call RETURNED, which is not the namespace.
  if (acc.kind === "call" || acc.terminator === "(") return null;
  const before = operatorBefore(masked, start);
  if (before === "return") return "returned from a function";
  if (before === "=>") return "returned from an arrow function";
  // The name being declared, not a value being read: `const RATrackerIdb = ...`.
  if (before === "const" || before === "let" || before === "var") return null;
  if (CONSUMES_THE_VALUE.has(before)) return null;
  if (!HANDS_THE_VALUE_ON.has(before)) {
    return "in a position the resolver does not read (after " + JSON.stringify(before) + ")";
  }
  if (acc.terminator === "=") return "reassigned by a form the resolver does not read";
  if (USED_UP_BY.has(acc.terminator)) return null;

  let pos = acc.end;
  for (let step = 0; step < 4; step++) {
    const stop = expressionEnd(masked, pos);
    const c = masked[stop];
    // A ternary's condition goes nowhere: `x ? a : b` hands on a or b.
    if (c === "?") return null;
    if (c === undefined || c === ";") return boundOutsideTheResolver(ctx, start);
    const open = enclosingOpen(masked, stop);
    if (open === null) return boundOutsideTheResolver(ctx, start);
    if (masked[open] === "[") return "an element of an array";
    if (masked[open] === "{") {
      return opensObjectLiteral(masked, open) ? "a property of an object" : boundOutsideTheResolver(ctx, start);
    }
    if (!opensGroup(masked, open)) return "an argument to a call";
    if (STATEMENT_KEYWORDS.has(wordBefore(masked, open))) return null; // `if (NS)` tests it
    const close = matchingClose(masked, open);
    if (close === null) return boundOutsideTheResolver(ctx, start);
    /* A grouping paren: the value carries on outside it - and if something is
     * ACCESSED on it out there, `accessOn` has already declined to follow the
     * value through this expression (`(0, window).RAThing` is a sequence, which
     * `namespaceValue` does not read), so that member is checked nowhere. */
    if (accessorAt(masked, close + 1).kind !== "none") {
      return "reached through an expression the resolver does not read";
    }
    pos = close + 1;
  }
  return "in an expression the resolver stopped following";
}

/** A value that reached the end of its expression inside something that BINDS,
 *  without any binding here having claimed it. */
function boundOutsideTheResolver(ctx, start) {
  const binding = ctx.assignments.find((range) => start > range.from && start < range.to);
  if (!binding || binding.exempt) return null;
  return "bound by a form the resolver does not read";
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
    const { locals, claimed, puzzles, destructures, fromGlobal, assignments } = collectLocals(masked, published);
    const { aliases, thunks } = locals;
    for (const why of puzzles.values()) unresolvable.push(rel + ": " + why);
    /* What `accessOn` and `dispositionOf` need in order to answer their
     * questions about a value that starts at `start`: the file's locals, the
     * reads some binding consumed, and the ranges a binding would carry one
     * into. */
    const about = (start) => ({ locals, claimed, assignments, start });

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

    const chain = (ns, member, acc, reference, start) => {
      const entry = published.get(ns);
      if (!member || !entry || !entry.thunks.has(member)) return;
      const called = callEnd(masked, acc.end);
      if (called === null) return;
      const far = entry.thunks.get(member);
      const inner = accessOn(masked, called, about(start));
      const ref = reference + "." + member + "()";
      /* `state.dlg = NOTIFY.dialog();` and `use(dialog())`: the CALL of an
       * exported thunk hands back the far namespace, and a far namespace that
       * goes somewhere without a member being read off it here is the same
       * escape as `state.t = root.RAThing`. It used to be silent, because the
       * only question asked after the call was "what member is read", and "none"
       * was an answer. */
      if (inner.kind === "none" || inner.kind === "call") {
        const escape = dispositionOf(masked, start, inner, about(start));
        if (escape) unresolvable.push(rel + ": " + ref + " is " + escape + ", so its members are not checked here");
        return;
      }
      readAccess(far, inner, ref, "thunk");
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

    /* EVERY MENTION OF THE GLOBAL OBJECT, and one classification each: the four
     * names that mean it, plus any local that was bound to it. What follows the
     * mention decides which of the five answers it is. Two of them end in a
     * check, two in a report, and one - the name being bound rather than read -
     * ends in neither, because it is not a read of the global object at all.
     * There is no sixth answer and no fall-through. */
    const mentions = [
      ...[...masked.matchAll(ROOT_TOKEN)].map((h) => ({ at: h.index, end: h.index + h[0].length, via: h[0] })),
      // A local named `root` is already in the list above, and reported there.
      ...[...locals.globals].filter((local) => !ROOT_NAMES.has(local)).flatMap((local) =>
        [...masked.matchAll(new RegExp("(?<![.\\w$])" + local + "(?![\\w$])", "g"))].map((h) => ({
          at: h.index,
          end: h.index + local.length,
          via: local,
        }))
      ),
    ];
    for (const { at, end, via } of mentions) {
      if (isMemberName(masked, at)) continue; // `out.self.endTurn` - a field, not the global object
      const bound = bindsTheName(masked, at, end);
      if (bound === "declaration") {
        /* Declaring the local that HOLDS the global object is the binding this
         * pass was told about. A declaration of one of the four names is a
         * different matter: it would make every read after it mean something
         * other than the global object. */
        if (ROOT_NAMES.has(via)) {
          unresolvable.push(rel + ": `" + via + "` is declared as a local here, so reads off it are not the global object");
        }
        continue;
      }
      if (bound === "parameter") {
        /* The module wrapper's own parameter. Reads off it ARE reads of the
         * global object, provided the wrapper was handed the global object -
         * which is checked rather than assumed. */
        const wrong = ROOT_NAMES.has(via) ? wrapperFeeding(masked, at) : null;
        if (wrong) unresolvable.push(rel + ": `" + via + "` " + wrong + ", so reads off it may not be the global object");
        continue;
      }
      if (bound) continue; // an object-literal key that happens to be spelled `root`

      const door = accessOn(masked, end, about(at));
      if (door.kind === "computed") {
        /* root[expr] - the NAMESPACE named by a value rather than by syntax,
         * which is a rung below a computed member read: not even the namespace
         * is known. Nothing resolves it, so the reference has to be visible. */
        const close = matchingClose(masked, masked.indexOf("[", end));
        const text = masked.slice(at, close === null ? end + 24 : close + 1);
        unresolvable.push(
          rel + ": a namespace read off the global object by expression, not by name: " +
            JSON.stringify(text.replace(/\s+/g, " "))
        );
        continue;
      }
      if (door.kind === "unreadable") {
        unresolvable.push(
          rel + ": a read off the global object in a form the resolver cannot read: " + JSON.stringify(door.text)
        );
        continue;
      }
      if (door.kind === "named") {
        const name = door.name;
        if (BROWSER_GLOBALS.has(name)) continue;
        if (/^\s*=(?!=)/.test(masked.slice(door.end, door.end + 8))) continue; // the publication itself
        const acc = accessOn(masked, door.end, about(at));
        if (acc.kind === "none" || acc.kind === "call") {
          check(name, null, name, "global");
          const escape = dispositionOf(masked, at, acc, about(at));
          if (escape) unresolvable.push(rel + ": " + name + " is " + escape + ", so its members are not checked here");
          continue;
        }
        chain(name, readAccess(name, acc, name, "direct"), acc, name, at);
        continue;
      }
      /* The global object itself is the value. Handing it to another file hands
       * over every namespace on it at once, so it is reported - unless it is
       * being handed to the module wrapper, whose parameter is scanned as the
       * global object in its own right. */
      const escape = dispositionOf(masked, at, door, about(at));
      if (!escape || (escape === "an argument to a call" && handedToModuleWrapper(masked, at))) continue;
      unresolvable.push(rel + ": the global object is " + escape + ", so the namespaces on it are not checked here");
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
        const acc = accessOn(masked, end, about(hit.index));
        const reference = local + "  (" + local + " = " + ns + ")";
        if (acc.kind === "none" || acc.kind === "call") {
          const escape = dispositionOf(masked, hit.index, acc, about(hit.index));
          if (escape) unresolvable.push(rel + ": " + reference + " is " + escape + ", so its members are not checked here");
          continue;
        }
        chain(ns, readAccess(ns, acc, reference, "alias"), acc, reference, hit.index);
      }
    }

    /* THUNK().member - and the two things a thunk can do OTHER than have a
     * member read off its result, both of which used to be nothing at all. */
    const exported = publishedThunkValues(masked, locals);
    for (const [local, ns] of thunks) {
      for (const hit of masked.matchAll(new RegExp("(?<![.\\w$])" + local + "(?![\\w$])", "g"))) {
        // `function store() { return root.RANs; }` is the thunk being declared,
        // not called: its `()` belongs to the parameter list.
        if (wordBefore(masked, hit.index) === "function") continue;
        const end = hit.index + local.length;
        const called = callEnd(masked, end);
        const reference = local + "()  (" + local + " = () => " + ns + ")";
        if (called === null) {
          /* The thunk ITSELF, not its result: `mount({ store: STORE })`, which
           * is this repo's universal deps-object handover. Deferring the read
           * does not make it local - the callee calls it and reads members off
           * what comes back, where no name resolution reaches - so it is the
           * same escape as passing the namespace, and it is reported as one.
           *
           * Except at the publication, which is where a thunk is MEANT to leave
           * the file: `root.RATrackerNotify = { dialog }` is recorded by
           * `readPublished`, and `NOTIFY.dialog().textPrompt(...)` two files away
           * resolves through that record. Only the top-level values of a
           * published literal are exempt; a thunk buried deeper is not followed
           * by anything, so it reports like the rest. */
          // `mount({ dialog: dialog() })` names the thunk twice and hands it on
          // once: the first is a KEY, which is not a read of anything.
          if (bindsTheName(masked, hit.index, end)) continue;
          const acc = accessOn(masked, end, about(hit.index));
          if (acc.kind !== "none") continue; // a property of the function object, not of the namespace
          if (exported.some((r) => hit.index > r.from && hit.index < r.to && r.names.has(local))) continue;
          const escape = dispositionOf(masked, hit.index, acc, about(hit.index));
          if (escape) {
            unresolvable.push(
              rel + ": " + local + "  (" + local + " = () => " + ns + ") is " + escape +
                ", so its members are not checked here"
            );
          }
          continue;
        }
        const acc = accessOn(masked, called, about(hit.index));
        // `use(dialog())` - the far namespace handed on, with no member read here.
        if (acc.kind === "none" || acc.kind === "call") {
          const escape = dispositionOf(masked, hit.index, acc, about(hit.index));
          if (escape) unresolvable.push(rel + ": " + reference + " is " + escape + ", so its members are not checked here");
          continue;
        }
        chain(ns, readAccess(ns, acc, reference, "thunk"), acc, reference, hit.index);
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
 * destructure 97 - 431 member references - and 175 name-level reads.
 *
 * The name-level count jumped from 107 to 175 when the entry side was closed,
 * and none of that is new coverage of members: it is doors that used to be
 * invisible now being counted once each. Most of it is the CommonJS footer
 * `module.exports = (typeof window !== "undefined" ? window : globalThis).RAT*`
 * that thirty-five files carry, which no version of this file had ever seen.
 * The member total did not move by one - the same 431 member references resolve
 * - which is the check that closing the door changed what is SEEN rather than
 * what is resolved.
 *
 * Fixing the LEXER moved no count either, and that is worth writing down rather
 * than being relieved about. The span dashboard/bundle.js:112 was blanking held
 * no cross-file reference, so nothing was being lost yet - the defeat was
 * constructed by MOVING a reference into such a span, not by finding one there.
 * A count that does not move when a stage upstream of the counting is repaired
 * means the repo was lucky, not that the stage was sound.
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
const NAME_FLOOR = 168;

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
   *     opened;
   *   - a THUNK leaving the file: the thunk itself handed on
   *     (`mount({ store: STORE })`, this repo's universal deps-object idiom) or
   *     what its CALL returned handed on (`state.dlg = NOTIFY.dialog();`,
   *     `use(dialog())`). Both were silent until the sixth round: the only
   *     question asked after a thunk call was which member is read, and "none"
   *     was an answer rather than a report. Deferring a read does not keep it
   *     local - the callee calls the thunk and reads members off what comes
   *     back, which is the same seam as handing the namespace over directly.
   *     The publication `root.RATrackerNotify = { dialog }` is not that, and is
   *     the one exemption: it IS followed, through `entry.thunks`;
   *   - a namespace or the global object reaching a BINDING the resolver did
   *     not read: `const T = (0, root.RAThing);`, `let T; T = root.RAThing;`, a
   *     class field, or whatever is invented next. The resolver does not have to
   *     recognise the expression to report it - it only has to notice that a
   *     value it was following ended up inside something that binds;
   *   - a read off the global object in an entry syntax this file cannot read,
   *     and a `const`/`let`/`var` of one of the four root names, which would
   *     make every read after it mean something else;
   *   - a module wrapper whose `root` parameter is handed something other than
   *     the global object, which would make that whole file's reads fictional.
   *
   * The viewer's boot check, `REQUIRED.filter((name) => !root[name])`, is the
   * `root[name]` entry. The names it looks for are STRINGS, which the masker
   * blanks before any of this runs, so the namespace itself is unknown here - a
   * rung below a computed member read, where at least the namespace has a name.
   * It is listed rather than described so that a consumer moving to a
   * string-keyed lookup has to come through this assertion.
   *
   * The last three entries are new, and they are what closing the entry side
   * made visible: the GLOBAL OBJECT ITSELF crossing a call boundary, which every
   * previous version of this file was blind to because it only ever looked at
   * `root` when a dot followed it. Handing over the global object hands over
   * every namespace on it at once, so each is a seam of the same kind as the idb
   * injection above:
   *   - dashboard/share-pipeline.js `window.RARepaint.repaint(window)` and
   *     share/worker/public/viewer.js `root.RARepaint.repaint(root)` hand it to
   *     share/repaint.js, which uses it for requestAnimationFrame only;
   *   - share/clipboard.js `root.prompt.bind(root)` hands it to a platform
   *     function as its `this`.
   * None of the three reads an RA* namespace off what it was handed, and none
   * can be followed statically, so they are named here. A fourth would be a
   * prompt to check the same thing about it.
   *
   * And the boundary of the claim, stated plainly, because three rounds have
   * overclaimed it. This list is total for namespace values THIS SCAN SEES, and
   * what the scan sees is now every mention of the global object rather than
   * every mention that matched a regex. It is still not total for the extension:
   *   - a namespace that escapes into a parameter is named here, but what the
   *     CALLEE then does with it is invisible; that is the seam above.
   *   - a value that both flows through an expression this reader cannot decide
   *     AND is handed onward in the same breath (`f(cond ? NS : other)`) is
   *     reported at the point it escapes, not at the point it was chosen.
   *   - a namespace reached through neither the global object nor a local bound
   *     from it - through `this`, say, or an import - is not modelled at all.
   *     Nothing in the extension does that today; the member floors are what
   *     would notice consumers moving there wholesale. */
  assert.deepEqual(unresolvable, [
    "background.js: RATrackerIdb is a property of an object, so its members are not checked here",
    "dashboard/legacy.js: RATrackerIdb is a property of an object, so its members are not checked here",
    "dashboard/share-pipeline.js: the global object is an argument to a call, so the namespaces on it are not checked here",
    "share/clipboard.js: the global object is an argument to a call, so the namespaces on it are not checked here",
    'share/worker/public/viewer.js: a namespace read off the global object by expression, not by name: "root[name]"',
    "share/worker/public/viewer.js: the global object is an argument to a call, so the namespaces on it are not checked here",
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
    /* THE ENTRY forms, which is where the fifth audit went through. Every one of
     * these was a door the resolver did not know was a door, so the member taken
     * off it afterwards was checked nowhere and renaming the key stayed green. */
    "destructured off the global object": "const { RAThing } = window;\nRAThing.wrong();",
    "destructured off the global object and renamed": "const { RAThing: T } = globalThis;\nT.wrong();",
    "a newline before the dot": "window\n  .RAThing.wrong();",
    "a comment before the dot": "window /* still the global object */.RAThing.wrong();",
    "whitespace around an optional dot": "self ?.\n  RAThing . wrong();",
    "off a parenthesised global object": "const v = (window).RAThing.wrong;",
    "off a local holding the global object": "const G = window;\nG.RAThing.wrong();",
    "off a local holding the global object through a fallback": "const G = injected || root;\nG.RAThing.wrong();",
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

test("a way IN this file was never taught is reported, not passed over", () => {
  /* The entry side of the same property, and the side the fifth audit went
   * through. Every case here puts a namespace - or the global object itself -
   * into a name by an expression `namespaceValue` cannot read. None of them may
   * be silent, because a member read off that name afterwards is checked
   * nowhere, which is what `const { RATrackerStorage } = window;` plus a rename
   * of `writeShares` proved: 809 green, both live call sites reading
   * `undefined`. */
  const publish = "root.RAThing = { wanted };\nroot.RAOther = { wanted };\n";
  const doors = {
    "a comma sequence": "const T = (0, root.RAThing);\nT.wanted();",
    "a comma sequence read straight through": "(0, window).RAThing.wanted();",
    "an array round trip": "const T = [root.RAThing][0];\nT.wanted();",
    "a Map round trip": "const m = new Map();\nm.set('t', root.RAThing);\nm.get('t').wanted();",
    "a copy": "const T = Object.assign({}, root.RAThing);\nT.wanted();",
    "a spread": "const T = { ...root.RAThing };\nT.wanted();",
    "a class field": "class X { ns = root.RAThing; }",
    "a parameter": "function use(NS) { NS.wanted(); }\nuse(root.RAThing);",
    "a reassignment": "let T;\nT = root.RAThing;\nT.wanted();",
    "a namespace named by a string": "const T = globalThis['RAThing'];\nT.wanted();",
    "a choice between two namespaces": "const T = flag ? root.RAThing : root.RAOther;\nT.wanted();",
    "the global object into an array": "const gs = [window];\ngs[0].RAThing.wanted();",
    "the global object into a binding this file does not read": "const G = (0, window);\nG.RAThing.wanted();",
  };
  for (const [form, use] of Object.entries(doors)) {
    const got = scan({ "a.js": publish, "b.js": use });
    assert.deepEqual(got.problems, [], form + " is not a broken reference, only an unfollowable one: " + use);
    assert.ok(got.unresolvable.length >= 1, form + " must be named in unresolvable: " + use);
  }

  /* And the counterfactual, stated as the fact that makes it hold - the same
   * shape of argument as the `?.` one above. The report does NOT come from
   * recognising the expression. `namespaceValue` has never heard of a sequence
   * expression, an array subscript or a spread, and says "not a namespace" for
   * all three; they are reported anyway, because the value was followed to the
   * end of an expression that BINDS and no binding here claimed it. Teaching
   * this file a new binding syntax therefore moves a case from this test to the
   * one above, and forgetting to teach it costs a resolved reference and a line
   * here - not silence. */
  const blank = { aliases: new Map(), thunks: new Map(), globals: new Set() };
  for (const expr of ["(0, root.RAThing)", "[root.RAThing][0]", "{ ...root.RAThing }"]) {
    const src = "const T = " + expr + ";";
    const masked = maskLiterals(src);
    const value = namespaceValue(masked, src.indexOf("= ") + 1, src.lastIndexOf(";"), blank);
    assert.ok(!value.ns && !value.globalObject, "`" + expr + "` must be an expression the reader cannot decide");
  }
});

test("the global object crossing a boundary is named, and the module wrapper is checked not assumed", () => {
  /* Handing over the global object hands over every namespace on it at once, so
   * it is an escape of the same kind as handing over one namespace - and the
   * repo does it three times, which no earlier version of this file could see.
   *
   * The one place it is NOT an escape is the wrapper every module here ends
   * with, and that is not a spelling exemption: it holds because the value
   * crosses into a PARAMETER named `root`, and reads off that name are scanned
   * as reads of the global object in their own right. Change what the wrapper is
   * handed and the exemption has to fail, or it is not a check. */
  const publish = "root.RAThing = { wanted };\n";
  const wrapper = (arg) => "(function (root) {\n  root.RAThing.wanted();\n})(" + arg + ");\n";

  const closed = scan({ "a.js": publish, "b.js": wrapper('typeof window !== "undefined" ? window : globalThis') });
  assert.deepEqual(closed.problems, []);
  assert.deepEqual(closed.unresolvable, [], "the module wrapper is not an escape: its parameter IS the global object");

  /* The same wrapper written as an arrow. `wrapperFeeding` - this seam checked
   * from the INSIDE - reads that form already, so matching only `function` on
   * the outside reported an escape the other half agreed was not one. Noise
   * rather than silence, but a guard whose two halves contradict each other is a
   * guard people learn to skim. */
  const arrow = scan({ "a.js": publish, "b.js": "((root) => {\n  root.RAThing.wanted();\n})(window);\n" });
  assert.deepEqual(arrow.problems, []);
  assert.deepEqual(arrow.unresolvable, [], "the arrow spelling of the wrapper is the same seam");
  const arrowWrong = scan({ "a.js": publish, "b.js": "((root) => {\n  root.RAThing.wanted();\n})(other);\n" });
  assert.equal(arrowWrong.unresolvable.length, 1, "an arrow wrapper handed something else must be reported");

  const wrong = scan({ "a.js": publish, "b.js": wrapper("someOtherObject") });
  assert.equal(wrong.unresolvable.length, 1, "a wrapper handed something else must be reported");
  assert.match(wrong.unresolvable[0], /handed something other than the global object/);

  // ...and the same for a local that takes the global object's place.
  const shadowed = scan({ "a.js": publish, "b.js": "const root = fake;\nroot.RAThing.wanted();\n" });
  assert.equal(shadowed.unresolvable.length, 1);
  assert.match(shadowed.unresolvable[0], /declared as a local here/);

  // A parameter named `self` on some ordinary function is the same problem as a
  // `const self`, and is reported rather than assumed either way.
  const borrowed = scan({ "a.js": publish, "b.js": "const run = (self) => self.tick();\n" });
  assert.match(borrowed.unresolvable.join(), /is a parameter of a function that is not an immediately invoked wrapper/);

  // The three ways the repo hands the global object over, each of which must be
  // visible where it happens.
  for (const use of ["repaint(window);", "const all = [root];", "thing.bind(root);"]) {
    const got = scan({ "a.js": publish, "b.js": use });
    assert.equal(got.unresolvable.length, 1, "the global object must not cross silently: " + use);
    assert.match(got.unresolvable[0], /the global object is/);
  }

  /* And the names that merely LOOK like the global object are not it: an object
   * key spelled `root`, a field spelled `self`. A guard that reports an object
   * literal's own keys as escaping namespaces reports nothing. */
  const quiet = {
    "an object key": "const SEL = {\n  root: '[data-testid=\"x\"]',\n};\n",
    "an object key in a returned literal": "const blank = () => ({\n  self: side(),\n});\n",
    "a field of a tally": "out.self.endTurn += 1;\n",
    "a field of a tally, read": "const n = out.self.endTurn;\n",
  };
  for (const [form, use] of Object.entries(quiet)) {
    const got = scan({ "a.js": publish, "b.js": use });
    assert.deepEqual(got.unresolvable, [], form + " is not the global object: " + use);
    assert.deepEqual(got.problems, [], form + " is not the global object: " + use);
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

  /* A thunk that leaves the file, in both halves: the thunk itself, and what its
   * call returned. Every one of these was silent - the far namespace crossed a
   * boundary and nothing said so - because the only question asked after a thunk
   * call was which member is read, and "none" was an answer. Deferring the read
   * does not make it local: the callee calls the thunk and reads members off the
   * result, exactly where no name resolution reaches. */
  const escapes = {
    "the call's result stored on a field": "const N = root.RANotify;\nstate.d = N.dialog();",
    "the call's result passed as an argument": "use(root.RANotify.dialog());",
    "the call's result in a deps object": "const { dialog } = root.RANotify;\nmount({ dialog: dialog() });",
    "the thunk itself passed as an argument": "const { dialog } = root.RANotify;\nuse(dialog);",
    "the thunk itself in a deps object": "const { dialog } = root.RANotify;\nmount({ dialog });",
    "a local thunk in a deps object": "const S = () => root.RADialog;\nmount({ dialog: S });",
  };
  for (const [form, use] of Object.entries(escapes)) {
    const got = scan({ "a.js": publish, "b.js": use });
    assert.deepEqual(got.problems, [], form + " is not a broken reference, only an unfollowable one: " + use);
    assert.equal(got.unresolvable.length, 1, form + " must be named in unresolvable: " + use);
  }

  /* ...and the thunk idioms that stay put are not reported, including the
   * PUBLICATION itself. `root.RANotify = { say, dialog }` is how a thunk is
   * meant to leave its file and it is followed, not guessed at: `readPublished`
   * records what `dialog` defers to and the cases above resolve through that
   * record. Reporting it would be naming the one hand-over this file reads. */
  const quiet = {
    "the publication of a thunk": "const noop = 1;",
    "a member read off the call": "root.RANotify.dialog().wanted();",
    "the call bound to a local": "const d = root.RANotify.dialog();\nd.wanted();",
    "the call as a statement": "root.RANotify.dialog();",
    "destructured from the call": "const { wanted } = root.RANotify.dialog();",
  };
  for (const [form, use] of Object.entries(quiet)) {
    const got = scan({ "a.js": publish, "b.js": use });
    assert.deepEqual(got.unresolvable, [], form + " must not be reported: " + use);
    assert.deepEqual(got.problems, [], form + " must not be a problem: " + use);
  }
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

test("the masker tells a regex literal from a division, and a regex body opens no string", () => {
  /* THE ONE TEST UPSTREAM OF EVERYTHING ELSE IN THIS FILE.
   *
   * Every other proof here - `?.` is not a terminator, a sequence expression is
   * reported without being understood - is downstream of the masker: it argues
   * about what happens to text the scan is SHOWN. This argues about what it is
   * shown, and until the sixth audit nothing did. The only masker test was the
   * template one below, and the regex/division decision the whole scan rests on
   * had none at all.
   *
   * Every case is a `/` that a last-CHARACTER rule reads as division. If it is
   * read that way, the quote inside the literal opens a string and the code
   * after it is blanked - which no closed list downstream can report, because
   * nothing is left to classify. So each case asserts the reference AFTER the
   * literal survives masking. */
  const NAMESPACE_READ = /(?<![.\w$])(?:root|window|globalThis|self)\s*\??\.\s*[A-Za-z_$][\w$]*/g;
  const masks = (src) => {
    const masked = maskLiterals(src);
    assert.equal(masked.length, src.length, "offsets must survive masking: " + src);
    for (let i = 0; i < src.length; i++) {
      assert.ok(masked[i] === src[i] || masked[i] === " ", "masking may only blank characters: " + src);
      if (src[i] === "\n") assert.equal(masked[i], "\n", "line numbering must survive masking: " + src);
    }
    /* The stronger form, and the one that reports rather than deletes: a
     * `root.RA*` the source contains must still be there afterwards. A masker
     * bug then shows up as a reference that fails to resolve, not as one that
     * was never seen. */
    for (const hit of src.matchAll(NAMESPACE_READ)) {
      assert.equal(
        masked.slice(hit.index, hit.index + hit[0].length),
        hit[0],
        "masking removed a read the source contains: " + JSON.stringify(hit[0]) + " in " + src
      );
    }
    return masked;
  };

  const regexes = {
    // dashboard/bundle.js:112, as it is written in the repo today. This is the
    // one that lost the sixth round: 164 characters blanked, lines 112-126.
    "a quote-bearing regex after `return`":
      'const cell = (s) => {\n' +
      '  return /[",\\n]/.test(s) ? \'"\' + s.replace(/"/g, \'""\') + \'"\' : s;\n' +
      '};\n' +
      'root.RAThing.wanted();\n',
    // The `)` of a statement head closes a test, not a value.
    "after the `)` of an if": 'if (ok) /"/.test(s);\nroot.RAThing.wanted();\n',
    "after the `)` of a while": 'while (ok) /"/.test(s);\nroot.RAThing.wanted();\n',
    // A `/` inside a character class does not end the literal, and a quote in
    // there is one more character of the body.
    "a `/` and a quote inside a character class": 'const re = /[/"]/;\nroot.RAThing.wanted();\n',
    "an escaped quote in the body": 'const re = /\\"x/;\nroot.RAThing.wanted();\n',
    "after `typeof`, `case` and `in`": 'switch (t) {\n  case /"/.test(s):\n    break;\n}\nroot.RAThing.wanted();\n',
    "after a `}`": 'function f() {}\n/"/.test(s);\nroot.RAThing.wanted();\n',
    "a regex with flags": 'const re = /"/gi;\nroot.RAThing.wanted();\n',
  };
  for (const [form, src] of Object.entries(regexes)) {
    const masked = masks(src);
    assert.ok(masked.includes("root.RAThing.wanted"), form + " must not swallow the code after it: " + src);
    assert.ok(!masked.includes('",'), form + " must blank the regex body itself: " + src);
  }

  /* ...and the decision has to go the OTHER way where it is a division, or the
   * masker blanks real code between two of them. */
  const divisions = {
    "between identifiers": "const r = a / c / d;\nroot.RAThing.wanted();\n",
    "after a `)`": "const r = (a + b) / c / d;\nroot.RAThing.wanted();\n",
    "after a `]`": "const r = xs[0] / c / d;\nroot.RAThing.wanted();\n",
    "after `++`": "const r = n++ / c / d;\nroot.RAThing.wanted();\n",
    "after a string literal": 'const r = "1" / c / d;\nroot.RAThing.wanted();\n',
    "after a template literal": "const r = `1` / c / d;\nroot.RAThing.wanted();\n",
    "after a regex literal's test": 'const r = /x/.test(s) / c / d;\nroot.RAThing.wanted();\n',
  };
  for (const [form, src] of Object.entries(divisions)) {
    const masked = masks(src);
    assert.ok(masked.includes("/ c / d"), form + " is a division, and its operands are code: " + src);
  }

  /* The bound on ANY misreading that gets past the two rules above, and the
   * reason a seventh shape here would cost a wrong answer rather than a silent
   * one: nothing that is guessed at can blank a newline. A quote with no partner
   * before the end of its line is not a string opener, so the worst a misread
   * operator can do is lose the rest of the line it is on. */
  const stray = maskLiterals('const bad = ";\nroot.RAThing.wanted();\n');
  assert.ok(stray.includes("root.RAThing.wanted"), "an unpartnered quote must blank nothing beyond its line");

  /* And end to end, which is the defeat itself: the helper copied out of
   * dashboard/bundle.js, with a live cross-file reference below it. Before the
   * lexer was fixed this pair was silent - `problems` empty, every floor held -
   * while the reference it deleted called a function that no longer existed. */
  const publish = "root.RAThing = { wanted };\n";
  const helper = 'const quoted = (s) => { return /[",\\n]/.test(s); };\n';
  const renamed = scan({ "a.js": publish, "b.js": helper + "root.RAThing.wrong();\n" });
  assert.equal(renamed.problems.length, 1, "a regex above a reference must not delete the reference");
  const clean = scan({ "a.js": publish, "b.js": helper + "root.RAThing.wanted();\n" });
  assert.deepEqual(clean.problems, []);
  assert.deepEqual(clean.unresolvable, []);
});

test("masking the shipped tree blanks literals and leaves the code standing", () => {
  /* The same properties over the 62 files this scan actually reads, because the
   * synthetic cases above only prove what someone thought to write down.
   *
   * Bracket balance is the structural half: masking removes literals, and a
   * literal contains no unmatched bracket, so masked code balances exactly when
   * the file does. A span of real code blanked by a mis-lex takes its brackets
   * with it and this stops being true - which is how the demonstrated defeat's
   * second edit shows up here, nine unclosed brackets deep, quite apart from
   * whichever reference it happened to delete. */
  for (const full of shippedJs(repo)) {
    const rel = path.relative(repo, full).split(path.sep).join("/");
    const src = fs.readFileSync(full, "utf8");
    const masked = sources.get(rel);
    assert.equal(masked.length, src.length, rel + ": offsets must survive masking");
    let depth = 0;
    for (let i = 0; i < src.length; i++) {
      assert.ok(masked[i] === src[i] || masked[i] === " ", rel + ": masking may only blank characters");
      if (src[i] === "\n") assert.equal(masked[i], "\n", rel + ": line numbering must survive masking");
      if (OPENERS.includes(masked[i])) depth++;
      else if (CLOSERS.includes(masked[i])) depth--;
      assert.ok(depth >= 0, rel + ": masked code closes a bracket it never opened, at offset " + i);
    }
    assert.equal(depth, 0, rel + ": masked code leaves " + depth + " bracket(s) open - masking has eaten code");

    /* And it must still PARSE. Bracket balance is necessary, not sufficient:
     * a mis-lexed `/` that closes on a `/` inside template text can swallow
     * that template's opening backtick, promote its closing one to an opener,
     * and blank whole lines with the brackets still even - silently, which is
     * the one failure mode nothing downstream can see. Handing the masked text
     * to the parser is what turns that back into a loud error. The masker is
     * not claimed to be RIGHT; this is what bounds being wrong. */
    /* The handful of ES modules cannot go to vm.Script as they stand, and
     * vm.SourceTextModule needs a flag the suite does not run with. Their
     * module syntax is blanked first - offset for offset, same rule as the
     * masker itself - which leaves the body, where every reference lives. */
    const script = masked
      .replace(/^[ \t]*import\b[^;\n]*;?/gm, (m) => " ".repeat(m.length))
      // `export default {…}` would leave a bare block, so it becomes `void`
      // instead - same width, and an object literal is a valid operand.
      .replace(/\bexport\s+default\b/g, (m) => "void" + " ".repeat(m.length - 4))
      .replace(/^([ \t]*)export\b/gm, (m) => " ".repeat(m.length));
    assert.doesNotThrow(
      () => new vm.Script(script, { filename: rel }),
      rel + ": masked code no longer parses - masking has eaten code"
    );
  }
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
