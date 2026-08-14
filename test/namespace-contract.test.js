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
 * reference. Offsets are preserved so a hit can still be reported by line. */
function maskLiterals(source) {
  const out = source.split("");
  const n = source.length;
  let i = 0;
  let prev = ""; // last non-space code character, for the regex/divide decision
  const blank = (at) => {
    if (source[at] !== "\n") out[at] = " ";
  };

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];

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
    if (c === '"' || c === "'" || c === "`") {
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
  }
  return { keys };
}

const PUBLICATION = /\b(?:root|window|globalThis|self)\.(RA[A-Za-z0-9_]*)(?![\w$])\s*=\s*/g;

/**
 * Reads every `root.RAThing = ...` publication out of `sources`.
 *
 * Two RHS forms occur: the object literal written inline (capture/*, dashboard/*)
 * and an identifier holding one declared just above (`const api = {...};
 * root.RAShareUI = api;` in share/* and replay/*, `bridge` in legacy.js). An
 * identifier that resolves to no object literal - dashboard/main.js publishes a
 * bare function as RATrackerToast - is recorded as opaque, so a member read off
 * it is reported rather than assumed fine.
 */
function readPublished(sources) {
  const published = new Map();
  const shapeErrors = [];
  for (const [rel, masked] of sources) {
    PUBLICATION.lastIndex = 0;
    let hit;
    while ((hit = PUBLICATION.exec(masked))) {
      const ns = hit[1];
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

      const entry = published.get(ns) || { keys: new Set(), opaque: null, sites: [] };
      entry.sites.push(rel);
      if (result.error) shapeErrors.push(rel + ": " + ns + " - " + result.error);
      else if (result.opaque) entry.opaque = rel + " publishes it as the value of `" + result.opaque + "`";
      else for (const k of result.keys) entry.keys.add(k);
      published.set(ns, entry);
    }
  }
  return { published, shapeErrors };
}

/* ------------------------------------------------------------------ *
 * Who reaches into them
 * ------------------------------------------------------------------ */

const NS_ROOT = "(?:root|window|globalThis|self)";
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
 */
function resolveReferences(sources, published) {
  const problems = [];
  const unresolvable = [];
  let resolved = 0;

  for (const [rel, masked] of sources) {
    const aliases = new Map();
    for (const hit of masked.matchAll(ALIAS)) aliases.set(hit[1], hit[2]);

    const params = parameterNames(masked);
    for (const local of [...aliases.keys()]) {
      const declarations = [
        ...masked.matchAll(new RegExp("\\b(?:const|let|var|function|class)\\s+" + local + "(?![\\w$])", "g")),
      ].length;
      if (declarations > 1 || params.has(local)) {
        unresolvable.push(
          rel + ": `" + local + "` (= " + aliases.get(local) + ") is rebound elsewhere in the file"
        );
        aliases.delete(local);
      }
    }

    const check = (ns, member, reference) => {
      const entry = published.get(ns);
      const at = rel + ": " + reference;
      if (!entry) return problems.push(at + " - no file publishes `" + ns + "`");
      if (entry.opaque) return problems.push(at + " - " + entry.opaque + ", so members cannot be checked");
      if (!entry.keys.has(member)) {
        return problems.push(at + " - " + entry.sites.join(" / ") + " publishes no `" + member + "`");
      }
      resolved++;
    };

    // root.RAThing.member
    for (const hit of masked.matchAll(new RegExp(NS_ROOT + "\\.(RA[A-Za-z0-9_]*)\\.([A-Za-z_$][\\w$]*)", "g"))) {
      check(hit[1], hit[2], hit[1] + "." + hit[2]);
    }
    // root.RAThing[expr]
    for (const hit of masked.matchAll(new RegExp(NS_ROOT + "\\.(RA[A-Za-z0-9_]*)\\s*\\[", "g"))) {
      unresolvable.push(rel + ": computed member access on " + hit[1]);
    }
    // const { member, member } = root.RAThing  /  = ALIAS
    for (const hit of masked.matchAll(/\b(?:const|let|var)\s*\{/g)) {
      const walked = topLevelSegments(masked, hit.index + hit[0].length - 1);
      if (!walked) continue;
      const tail = /^\s*=\s*([A-Za-z_$][\w$.]*)(?![\w$])(?!\s*[.(\[?])/.exec(masked.slice(walked.end + 1));
      if (!tail) continue;
      const direct = new RegExp("^" + NS_ROOT + "\\.(RA[A-Za-z0-9_]*)$").exec(tail[1]);
      const ns = direct ? direct[1] : aliases.get(tail[1]);
      if (!ns) continue;
      for (const raw of walked.segments) {
        const s = raw.trim();
        if (!s) continue;
        if (s.startsWith("...")) {
          unresolvable.push(rel + ": rest element in a destructure of " + ns);
          continue;
        }
        const m = /^([A-Za-z_$][\w$]*)/.exec(s);
        if (m) check(ns, m[1], "{ " + m[1] + " } = " + ns);
        else unresolvable.push(rel + ": unparsed destructure of " + ns + ": " + JSON.stringify(s.slice(0, 40)));
      }
    }
    // alias.member  /  alias[expr]
    for (const [local, ns] of aliases) {
      for (const hit of masked.matchAll(new RegExp("(?<![.\\w$])" + local + "\\.([A-Za-z_$][\\w$]*)", "g"))) {
        check(ns, hit[1], local + "." + hit[1] + "  (" + local + " = " + ns + ")");
      }
      for (const _ of masked.matchAll(new RegExp("(?<![.\\w$])" + local + "\\s*\\[", "g"))) {
        unresolvable.push(rel + ": computed member access on " + local + " (= " + ns + ")");
      }
    }
  }
  return { problems, unresolvable: [...new Set(unresolvable)].sort(), resolved };
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
const { problems, unresolvable, resolved } = resolveReferences(sources, published);

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
    published.size >= 45,
    "only " + published.size + " namespaces found - has the `root.RAThing = {...}` idiom changed?"
  );
  const keyCount = [...published.values()].reduce((n, e) => n + e.keys.size, 0);
  assert.ok(keyCount >= 300, "only " + keyCount + " published keys found across " + published.size + " namespaces");

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
   * covers the other 247 besides. */
  assert.deepEqual(
    problems,
    [],
    problems.length + " cross-file reference(s) resolve to nothing:\n  " + problems.join("\n  ")
  );

  assert.ok(
    resolved >= 250,
    "only " + resolved + " references resolved - the alias idiom has changed and this guard is checking almost nothing"
  );
});

test("the references that cannot be resolved statically are these, and only these", () => {
  /* Listed rather than dropped. Each one is a reference the scan sees but
   * cannot decide, and leaving them implicit would let the set grow until the
   * guard covers nothing. A new entry here is a prompt to either teach the
   * resolver the form or accept it in writing.
   *
   * dashboard/main.js publishes RATrackerToast as a bare function rather than a
   * namespace object; dashboard/notify.js binds it and calls it, never reading a
   * member off it, so nothing is lost - but the binding is still recorded so a
   * member read off it would be reported by the test above. */
  assert.deepEqual(unresolvable, []);
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
