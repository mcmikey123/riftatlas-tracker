/* The share viewer's file list exists in three places, and nothing but this
 * file makes them agree.
 *
 * public/ subdirectories are gitignored: git holds one copy of each shared
 * module at the repo root, and sync-assets.sh copies it into public/ before a
 * deploy. So adding a module the viewer needs means editing three lists - the
 * <script> tags in index.html, the copy list in sync-assets.sh, and the globals
 * viewer.js checks for at boot. Miss the second and the deploy 404s; miss the
 * third and the page loads a module nobody reads.
 *
 * The symptom of any of those is identical and appears only in a recipient's
 * browser, on a link the sender cannot see fail: "This replay viewer is
 * missing part of itself." Cheaper to assert here, the same way the Worker's
 * CSP and object-id length are pinned in worker-headers.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.join(__dirname, "..");
const worker = path.join(repo, "share", "worker");
const read = (p) => fs.readFileSync(path.join(worker, p), "utf8");

const indexHtml = read("public/index.html");
const syncScript = read("sync-assets.sh");
const viewerSource = read("public/viewer.js");

/** Everything index.html loads, in order, as repo-relative paths. */
function scriptsInIndex() {
  return [...indexHtml.matchAll(/<script[^>]*\ssrc="\/([^"]+)"/g)].map((m) => m[1]);
}

/** The `for rel in \ ... ` list sync-assets.sh copies into public/. */
function pathsInSync() {
  const block = syncScript.match(/for rel in\s*\\\n([\s\S]*?)\ndo\n/);
  assert.ok(block, "sync-assets.sh must copy its files from a `for rel in \\` list");
  return block[1]
    .split("\n")
    .map((line) => line.replace(/\\\s*$/, "").trim())
    .filter(Boolean);
}

test("every script the viewer page loads is one the deploy script copies", () => {
  const scripts = scriptsInIndex();
  // viewer.js and its stylesheet live in public/ already and are not copied.
  const copied = scriptsInIndex().filter((src) => src !== "viewer.js");
  assert.ok(scripts.length > 0, "no <script src> found in index.html - has the markup changed?");

  const synced = new Set(pathsInSync());
  const missing = copied.filter((src) => !synced.has(src));
  assert.deepEqual(
    missing,
    [],
    "index.html loads these but sync-assets.sh never copies them, so the deploy " +
      "serves a 404 for each: " + missing.join(", ")
  );
});

test("the deploy script copies nothing the viewer page does not load", () => {
  const loaded = new Set(scriptsInIndex());
  // The stylesheet is referenced by <link>, not <script>, so it is expected here.
  const stray = pathsInSync().filter((rel) => !loaded.has(rel) && !rel.endsWith(".css"));
  assert.deepEqual(
    stray,
    [],
    "sync-assets.sh copies these but index.html never loads them - either the page " +
      "lost a script tag or the list has gone stale: " + stray.join(", ")
  );
});

test("every global viewer.js requires at boot is loaded before it", () => {
  /* viewer.js refuses to start unless each of these is present, which is the
   * check that turns a missing script into a readable message. If the required
   * list names a global no script provides, that message fires on every load. */
  const required = viewerSource.match(/const REQUIRED = \[([\s\S]*?)\]/);
  assert.ok(required, "viewer.js must declare its prerequisites as a REQUIRED array");
  const names = [...required[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 0, "REQUIRED is empty - viewer.js has stopped checking its own deps");

  const before = scriptsInIndex();
  const viewerAt = before.indexOf("viewer.js");
  assert.notEqual(viewerAt, -1, "index.html must load viewer.js");

  /* Each required global has to be published by some script the page loads
   * ahead of viewer.js. Read the sources rather than trusting the names.
   *
   * The REPO-ROOT copies, not the ones beside index.html: public/{replay,share,
   * store,vendor} are gitignored build output that only exists once
   * sync-assets.sh has run, so reading those made this test pass locally and
   * fail on every clean clone - reporting "no script defines RAReplayTimeline"
   * when the truth was "the assets have not been synced yet". The two tests
   * above already assert the deploy copies these exact paths, so checking the
   * tracked source checks the same file. */
  const earlier = before.slice(0, viewerAt);
  const published = earlier
    .map((rel) => {
      const full = path.join(repo, rel);
      return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
    })
    .join("\n");

  // vendor bundles are minified and publish their globals in forms a source
  // scan cannot see, so they are named rather than scraped.
  const fromVendor = new Set(["rrwebReplay"]);
  const unpublished = names.filter(
    (n) => !fromVendor.has(n) && !new RegExp("\\b" + n + "\\b").test(published)
  );
  assert.deepEqual(
    unpublished,
    [],
    "viewer.js requires these globals but no script loaded before it defines one: " +
      unpublished.join(", ")
  );
});

/** The `[global, member]` pairs viewer.js refuses to boot without. */
function requiredMembers() {
  const declared = viewerSource.match(/const REQUIRED_MEMBERS = \[([\s\S]*?)\n  \];/);
  assert.ok(declared, "viewer.js must declare its member checks as a REQUIRED_MEMBERS array");
  const pairs = [...declared[1].matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length > 0, "REQUIRED_MEMBERS is empty - the stale-deploy guard checks nothing");
  return pairs;
}

/** The globals in the REQUIRED array, as names. */
function requiredGlobals() {
  const required = viewerSource.match(/const REQUIRED = \[([\s\S]*?)\]/);
  assert.ok(required, "viewer.js must declare its prerequisites as a REQUIRED array");
  return [...required[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * The members `name` actually publishes, read off its export object.
 *
 * Every shared module ends the same way - `const api = { ... }` and then
 * `root.<Name> = api` - so the export block is what has to carry the member.
 * Scanning the whole file instead would match the identifier in a comment, in
 * an internal `const`, or in a call, and pass for a module that defines the
 * thing privately and never publishes it: the exact stale-deploy state this
 * suite is here to catch, going green.
 */
function publishedBy(name, sources) {
  const owner = sources.find((src) => new RegExp("root\\." + name + "\\s*=").test(src));
  if (!owner) return null;
  const block = owner.match(/const api = \{([\s\S]*?)\n?\s*\};/);
  return block ? block[1] : null;
}

/** Every shared module the page loads ahead of viewer.js, as source text. */
function sourcesBeforeViewer() {
  const before = scriptsInIndex();
  return before.slice(0, before.indexOf("viewer.js")).map((rel) => {
    const full = path.join(repo, rel);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
  });
}

test("every member viewer.js guards against a stale deploy is one its module publishes", () => {
  /* REQUIRED catches a script that never loaded. This catches the other half:
   * public/{replay,share,store} are gitignored duplicates refreshed by
   * sync-assets.sh, so a deploy that skipped it serves a current viewer.js
   * beside modules older than it - every global present, every REQUIRED name
   * satisfied, and the first member viewer.js reaches for undefined. That is
   * what shipped the speed control's <select> to a viewer whose timeline module
   * had no SPEEDS.
   *
   * The guard is only worth having if its list is true, and a list of string
   * pairs is exactly the thing a rename walks away from. A member named here
   * that its module does not publish would fail the boot check on every load,
   * for everyone, on a correctly synced deploy. Pinned against the repo-root
   * copies, for the same reason the REQUIRED test is. */
  const sources = sourcesBeforeViewer();

  const unpublished = requiredMembers()
    .filter(([name, member]) => {
      const exported = publishedBy(name, sources);
      return exported === null || !new RegExp("\\b" + member + "\\b").test(exported);
    })
    .map(([name, member]) => name + "." + member);

  assert.deepEqual(
    unpublished,
    [],
    "viewer.js refuses to boot without these, but the module that publishes the " +
      "global does not export them - every load would report a stale deploy: " +
      unpublished.join(", ")
  );
});

test("every member viewer.js reaches for is one the stale-deploy guard covers", () => {
  /* The other direction, and the one that decides whether the guard's comment
   * is true. A member used here and absent from REQUIRED_MEMBERS is a member a
   * stale deploy still throws on, part-way through start() - which is the
   * silent blank page, arriving despite the guard. RAReplayCore.available was
   * exactly that: called in the boot check itself, and unlisted.
   *
   * Two shapes are counted, because the file uses both: `root.X.y`, and a
   * destructure taken straight off the module. The destructure pattern demands
   * `= root.X;` with the semicolon, which is what separates it from
   *
   *   const { kind, message, retry } = root.RAShareViewer ? ... : ...
   *
   * where the names come from a ternary's result and are not members of
   * anything. Left ungreedy that line would put three imaginary members on the
   * list and fail this test forever. */
  const covered = new Set(requiredMembers().map(([name, member]) => name + "." + member));
  const used = new Set();

  for (const m of viewerSource.matchAll(/root\.(RA[A-Za-z]+)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    used.add(m[1] + "." + m[2]);
  }
  for (const m of viewerSource.matchAll(/const \{([^}]*)\} = root\.(RA[A-Za-z]+);/g)) {
    for (const name of m[1].split(",").map((part) => part.trim()).filter(Boolean)) {
      used.add(m[2] + "." + name);
    }
  }
  assert.ok(used.size > 0, "no member references found in viewer.js - has the scrape broken?");

  const unguarded = [...used].filter((ref) => !covered.has(ref)).sort();
  assert.deepEqual(
    unguarded,
    [],
    "viewer.js reaches for these but REQUIRED_MEMBERS does not list them, so a " +
      "stale deploy still dies silently on each: " + unguarded.join(", ")
  );
});

test("every global the member guard names is one the global guard already required", () => {
  /* REQUIRED_MEMBERS indexes into root[name] without checking it, which is only
   * safe because REQUIRED has already returned if any of them is absent. That
   * is a relationship between two arrays with nothing holding it together, so
   * it is asserted rather than assumed - and asserting it is what lets the
   * member check stay a plain index instead of a re-guard nobody can reach. */
  const globals = new Set(requiredGlobals());
  const unrequired = [...new Set(requiredMembers().map(([name]) => name))]
    .filter((name) => !globals.has(name))
    .sort();
  assert.deepEqual(
    unrequired,
    [],
    "REQUIRED_MEMBERS names these globals but REQUIRED does not, so the member " +
      "check would dereference undefined: " + unrequired.join(", ")
  );
});

test("every element viewer.js looks up exists in the viewer page", () => {
  /* viewer.js collects its chrome in one getElementById sweep and then uses the
   * results unguarded, so an id that markup does not carry is a null that
   * surfaces as a TypeError part-way through start() - the same silent, blank
   * page the stale-module guard prevents, arriving by the other road. Renaming
   * a control in one file and not the other is all it takes.
   *
   * The querySelector lookups are checked too: .viewer is the element
   * fullscreen is requested on and the hook two rules in viewer.css hang off,
   * so renaming it in the markup breaks fullscreen and leaves the page looking
   * fine - the one drift here that does not announce itself. */
  const sweep = viewerSource.match(/for \(const id of \[([\s\S]*?)\]\) \{/);
  assert.ok(sweep, "viewer.js must collect its elements from one `for (const id of [...])` list");
  const ids = [...sweep[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 0, "the element id list is empty - has start() been rewritten?");

  const inMarkup = new Set([...indexHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const absent = ids.filter((id) => !inMarkup.has(id));
  assert.deepEqual(
    absent,
    [],
    "viewer.js looks these up but index.html carries no such id, so each is null " +
      "the first time it is touched: " + absent.join(", ")
  );

  const classes = [...viewerSource.matchAll(/querySelector\("\.([\w-]+)"\)/g)].map((m) => m[1]);
  assert.ok(classes.length > 0, "viewer.js is expected to select .viewer by class");
  const classAttrs = [...indexHtml.matchAll(/\sclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
  const inMarkupClasses = new Set(classAttrs);
  const absentClasses = classes.filter((cls) => !inMarkupClasses.has(cls));
  assert.deepEqual(
    absentClasses,
    [],
    "viewer.js selects these classes but index.html carries none of them: " +
      absentClasses.join(", ")
  );
});

test("both surfaces draw the replay cursor the same way", () => {
  /* The two stylesheets are independent copies: viewer.css lives in public/
   * already and is one of the two files sync-assets.sh does NOT copy, so
   * nothing but this makes the dashboard modal and the shared-link viewer agree
   * on the cursor rrweb draws over the board.
   *
   * They cannot simply be the same file - the surfaces name the scaled element
   * differently (.vr-scale and .scale) - so what is compared is the declaration
   * after the selector, which is where the art and the touch-device exemption
   * both live. Retint one arrow and this fails at the source of the divergence,
   * rather than in a recipient's browser on a link the sender cannot see. */
  const dashboardCss = fs.readFileSync(path.join(repo, "dashboard", "dashboard.css"), "utf8");
  const viewerCss = read("public/viewer.css");
  /* The container is named per file and anchored to the start of a line. The
   * two surfaces scale under different class names, and a rule carrying the
   * other one is dead CSS: the dashboard would quietly fall back to rrweb's
   * black arrow with the declaration still agreeing here, byte for byte. */
  const rule = (css, container, where) => {
    const found = css.match(new RegExp(`^\\${container} (\\.replayer-mouse[^{]*)\\{([^}]*)\\}`, "m"));
    assert.ok(found, `${where} must style ${container} .replayer-mouse - has the override been dropped?`);
    return { suffix: found[1].trim(), body: found[2].trim() };
  };
  const dash = rule(dashboardCss, ".vr-scale", "dashboard.css");
  const viewer = rule(viewerCss, ".scale", "viewer.css");

  assert.equal(
    dash.suffix,
    viewer.suffix,
    "the two cursor rules select differently, so one surface exempts a cursor state " +
      "the other paints over: " + dash.suffix + " vs " + viewer.suffix
  );
  assert.equal(
    dash.body,
    viewer.body,
    "the two cursor rules draw different cursors; the shared-link viewer and the " +
      "dashboard modal must show the same one"
  );
  assert.match(dash.suffix, /:not\(\.touch-device\)/, "the touch-device ring must stay exempt");
});
