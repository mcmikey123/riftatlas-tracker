"use strict";

/* capture/sticky-memory.js is the deck picker's memory and the lobby format's
 * memory, which used to be two copies of one 45-line sequence differing in a
 * storage key, a reader and an equality test.
 *
 * Two things have to be true for that merge to be safe, and both are checked
 * here rather than argued:
 *
 *   1. THE SEQUENCE IS UNCHANGED. The read floor, the restamp, the throttled
 *      write and the load precedence are compared against the implementations
 *      they replaced - transcribed verbatim below - over every ordering of
 *      sighting and elapsed time that the boundaries make interesting.
 *
 *   2. WHAT IS ON DISK IS UNCHANGED. The generic version stores the reader's
 *      own shape plus `at`, so `activeDeck` is still {name, champion, at} and
 *      `activeFormat` is still {format, at}. An install that remembers a deck
 *      keeps remembering it, and no migration exists because nothing moved.
 *      The legacy-record tests are what would fail if that ever stopped being
 *      true - at which point a migration becomes required, not optional.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

// The module reads `chrome` as a global at call time, so the stub has to be in
// place before anything calls in - not before require.
const fakeChrome = { storage: { local: { get() {}, set() {} } } };
globalThis.chrome = fakeChrome;

const { createStickyMemory, READ_MIN_MS, STAMP_MS } = require("../capture/sticky-memory.js");
/* Both implementations start their "last read" and "last written" clocks at 0,
 * which under a real Date.now() is decades ago and lets the first sighting
 * through. A test clock starting at 0 would instead spend its first quarter
 * second inside the read floor, so every run starts here. */
const BASE = 1_000_000;

/** A chrome.storage.local stand-in that records every write, in order. */
function fakeStorage(seed) {
  const disk = Object.assign({}, seed);
  const writes = [];
  return {
    writes,
    disk,
    local: {
      set(obj) {
        writes.push(JSON.parse(JSON.stringify(obj)));
        Object.assign(disk, obj);
      },
      get(defaults, cb) {
        const out = {};
        for (const key of Object.keys(defaults)) {
          out[key] = key in disk ? disk[key] : defaults[key];
        }
        cb(out);
      },
    },
  };
}

/** Installs a storage stub for the duration of one case. */
function withStorage(seed, fn) {
  const storage = fakeStorage(seed);
  fakeChrome.storage = storage;
  try {
    return fn(storage);
  } finally {
    fakeChrome.storage = { local: { get() {}, set() {} } };
  }
}

// ---------------------------------------------------------------------------
// The implementations this replaced, transcribed from content.js as it stood
// before the merge (git 54376d0), with the clock and the reader lifted out so
// they can be driven. Nothing else about them is changed.
// ---------------------------------------------------------------------------

function legacyDeckMemory(readDeckPicker, now) {
  const DECK_READ_MIN_MS = 250;
  const DECK_STAMP_MS = 30000;
  let activeDeck = null;
  let deckReadAt = 0;
  let deckSavedAt = 0;

  function watchDeckPicker() {
    const at = now();
    if (at - deckReadAt < DECK_READ_MIN_MS) return;
    deckReadAt = at;

    const found = readDeckPicker();
    if (!found) return;
    const changed =
      !activeDeck ||
      activeDeck.name !== found.name ||
      activeDeck.champion !== found.champion;
    activeDeck = { name: found.name, champion: found.champion, at };
    if (!changed && at - deckSavedAt < DECK_STAMP_MS) return;
    deckSavedAt = at;
    try {
      chrome.storage.local.set({ activeDeck });
    } catch (_) {}
  }

  function loadActiveDeck() {
    try {
      chrome.storage.local.get({ activeDeck: null }, (d) => {
        if (d && d.activeDeck && d.activeDeck.name && !activeDeck) {
          activeDeck = d.activeDeck;
        }
      });
    } catch (_) {}
  }

  return { watch: watchDeckPicker, load: loadActiveDeck, get: () => activeDeck };
}

function legacyFormatMemory(readMatchFormat, now) {
  const FORMAT_READ_MIN_MS = 250;
  const FORMAT_STAMP_MS = 30000;
  let activeFormat = null;
  let formatReadAt = 0;
  let formatSavedAt = 0;

  function watchMatchFormat() {
    const at = now();
    if (at - formatReadAt < FORMAT_READ_MIN_MS) return;
    formatReadAt = at;

    const found = readMatchFormat();
    if (!found) return;
    const changed = !activeFormat || activeFormat.format !== found;
    activeFormat = { format: found, at };
    if (!changed && at - formatSavedAt < FORMAT_STAMP_MS) return;
    formatSavedAt = at;
    try {
      chrome.storage.local.set({ activeFormat });
    } catch (_) {}
  }

  function loadActiveFormat() {
    try {
      chrome.storage.local.get({ activeFormat: null }, (d) => {
        if (d && d.activeFormat && d.activeFormat.format && !activeFormat) {
          activeFormat = d.activeFormat;
        }
      });
    } catch (_) {}
  }

  return { watch: watchMatchFormat, load: loadActiveFormat, get: () => activeFormat };
}

// The two memories as they are configured in capture/deck-scan.js and
// capture/match-format.js. Kept in step with those files by the test at the
// bottom, which reads them.
const deckMemory = (read, now) =>
  createStickyMemory({
    key: "activeDeck",
    read,
    same: (held, found) => held.name === found.name && held.champion === found.champion,
    isStored: (stored) => !!stored.name,
    now,
  });

const formatMemory = (read, now) =>
  createStickyMemory({
    key: "activeFormat",
    read: () => {
      const found = read();
      return found ? { format: found } : null;
    },
    same: (held, found) => held.format === found.format,
    isStored: (stored) => !!stored.format,
    now,
  });

// ---------------------------------------------------------------------------

test("the read floor, the restamp and the throttled write behave as one sequence", () => {
  let clock = BASE;
  const now = () => clock;
  const sightings = [];
  withStorage({}, (storage) => {
    const mem = deckMemory(() => sightings.shift() ?? null, now);

    sightings.push({ name: "Bandle Bomb", champion: "Diana, Scorn of the Moon" });
    mem.watch();
    assert.deepEqual(mem.get(), {
      name: "Bandle Bomb",
      champion: "Diana, Scorn of the Moon",
      at: BASE,
    });
    assert.equal(storage.writes.length, 1, "a new sighting is written at once");

    // Inside the read floor: the reader is not even called, so the sighting
    // queued here survives to the next real read.
    clock = BASE + READ_MIN_MS - 1;
    sightings.push({ name: "Other", champion: "Ahri, Nine-Tailed" });
    mem.watch();
    assert.equal(mem.get().name, "Bandle Bomb", "the floor blocked the read");

    clock = BASE + READ_MIN_MS;
    mem.watch();
    assert.equal(mem.get().name, "Other", "past the floor, the read lands");
    assert.equal(storage.writes.length, 2);

    // The same deck seen again restamps in memory but does not write until the
    // stamp interval has passed.
    const same = { name: "Other", champion: "Ahri, Nine-Tailed" };
    clock = BASE + READ_MIN_MS + STAMP_MS - 1;
    sightings.push(Object.assign({}, same));
    mem.watch();
    assert.equal(mem.get().at, clock, "`at` means last seen, not last changed");
    assert.equal(storage.writes.length, 2, "unchanged and inside the stamp window");

    // Far enough past the last write for the stamp, and past the read floor
    // that the sighting before it left behind.
    clock = BASE + 2 * READ_MIN_MS + STAMP_MS;
    sightings.push(Object.assign({}, same));
    mem.watch();
    assert.equal(storage.writes.length, 3, "the stored stamp is refreshed");
  });
});

test("nothing on screen leaves the memory alone", () => {
  let clock = BASE;
  withStorage({}, (storage) => {
    const mem = deckMemory(() => null, () => clock);
    mem.watch();
    assert.equal(mem.get(), null);
    assert.deepEqual(storage.writes, [], "a page with no picker writes nothing");
  });
});

test("a live sighting outranks what storage remembers; nothing outranks nothing", () => {
  const stored = { name: "From Disk", champion: "Diana, Scorn of the Moon", at: 5 };
  withStorage({ activeDeck: stored }, () => {
    let clock = 1000;
    const mem = deckMemory(() => ({ name: "On Screen", champion: null }), () => clock);
    mem.watch();
    mem.load();
    assert.equal(mem.get().name, "On Screen", "the page beats the disk");
  });
  withStorage({ activeDeck: stored }, () => {
    const mem = deckMemory(() => null, () => 1000);
    mem.load();
    assert.deepEqual(mem.get(), stored, "with nothing on screen, the disk answers");
  });
});

test("a stored record the reader would have rejected is not restored", () => {
  // Half-written or empty records: `isStored` is the guard, and it is the same
  // truthiness check both call sites made inline before.
  for (const bad of [{}, { name: "" }, { champion: "Diana" }]) {
    withStorage({ activeDeck: bad }, () => {
      const mem = deckMemory(() => null, () => 0);
      mem.load();
      assert.equal(mem.get(), null, JSON.stringify(bad) + " must not be restored");
    });
  }
});

test("the deck record on disk is still {name, champion, at}", () => {
  /* THE MIGRATION TEST. An installed user's `activeDeck` was written by the
   * implementation this replaced; if the merge had normalised the two memories
   * onto one stored shape, every one of those records would have to be
   * migrated on read or the remembered deck would silently vanish. It did not,
   * and this is what says so: the legacy record loads verbatim, and the next
   * write is the same shape it always was. */
  const legacy = { name: "Bandle Bomb", champion: "Diana, Scorn of the Moon", at: 1234 };
  withStorage({ activeDeck: legacy }, (storage) => {
    const seen = { name: "Bandle Bomb", champion: "Diana, Scorn of the Moon" };
    const mem = deckMemory(() => seen, () => STAMP_MS + 1);
    mem.load();
    assert.deepEqual(mem.get(), legacy, "the record written by the old code loads as it is");

    // Seeing the same deck again restamps the legacy record in place rather
    // than replacing it with something of a different shape.
    mem.watch();
    assert.deepEqual(Object.keys(storage.writes[0].activeDeck).sort(), ["at", "champion", "name"]);
    assert.deepEqual(storage.writes[0].activeDeck, {
      name: "Bandle Bomb",
      champion: "Diana, Scorn of the Moon",
      at: STAMP_MS + 1,
    });
  });
});

test("the format record on disk is still {format, at}", () => {
  const legacy = { format: "bo3", at: 1234 };
  withStorage({ activeFormat: legacy }, (storage) => {
    const mem = formatMemory(() => "bo1", () => 9999);
    mem.load();
    assert.deepEqual(mem.get(), legacy);

    mem.watch();
    assert.deepEqual(Object.keys(storage.writes[0].activeFormat).sort(), ["at", "format"]);
    assert.deepEqual(storage.writes[0].activeFormat, { format: "bo1", at: 9999 });
  });
});

/* The differential runs. Every case drives the replaced implementation and the
 * merged one through the same sightings on the same clock and compares both
 * what is held in memory and every write that reached storage, in order. */

function driveBoth(build, legacyBuild, steps) {
  const run = (make) => {
    let clock = BASE;
    let i = 0;
    return withStorage({}, (storage) => {
      const mem = make(() => steps[i].sighting, () => clock);
      for (i = 0; i < steps.length; i++) {
        clock += steps[i].dt;
        mem.watch();
      }
      return { held: mem.get(), writes: storage.writes };
    });
  };
  return { fresh: run(build), legacy: run(legacyBuild) };
}

const DTS = [0, 1, READ_MIN_MS - 1, READ_MIN_MS, READ_MIN_MS + 1, STAMP_MS - 1, STAMP_MS, STAMP_MS + 1];


test("deck: the merged memory matches the one it replaced, over every ordering", () => {
  const looks = [
    null,
    { name: "Bandle Bomb", champion: "Diana, Scorn of the Moon" },
    { name: "Bandle Bomb", champion: "Ahri, Nine-Tailed" }, // same name, new champion
    { name: "Control", champion: "Diana, Scorn of the Moon" }, // same champion, new name
  ];
  let cases = 0;
  const step = (n) => ({ dt: DTS[n % DTS.length], sighting: looks[Math.floor(n / DTS.length) % looks.length] });
  const total = DTS.length * looks.length;
  for (let a = 0; a < total; a++) {
    for (let b = 0; b < total; b++) {
      for (let c = 0; c < total; c++) {
        const steps = [step(a), step(b), step(c)];
        const { fresh, legacy } = driveBoth(deckMemory, legacyDeckMemory, steps);
        assert.deepEqual(fresh.held, legacy.held, "held: " + JSON.stringify(steps));
        assert.deepEqual(fresh.writes, legacy.writes, "writes: " + JSON.stringify(steps));
        cases++;
      }
    }
  }
  assert.ok(cases >= 32768, "expected the whole space to be driven, got " + cases);
});

test("format: the merged memory matches the one it replaced, over every ordering", () => {
  const looks = [null, "bo1", "bo3"];
  let cases = 0;
  const step = (n) => ({ dt: DTS[n % DTS.length], sighting: looks[Math.floor(n / DTS.length) % looks.length] });
  const total = DTS.length * looks.length;
  for (let a = 0; a < total; a++) {
    for (let b = 0; b < total; b++) {
      for (let c = 0; c < total; c++) {
        const steps = [step(a), step(b), step(c)];
        const { fresh, legacy } = driveBoth(formatMemory, legacyFormatMemory, steps);
        assert.deepEqual(fresh.held, legacy.held, "held: " + JSON.stringify(steps));
        assert.deepEqual(fresh.writes, legacy.writes, "writes: " + JSON.stringify(steps));
        cases++;
      }
    }
  }
  assert.ok(cases >= 13824, "expected the whole space to be driven, got " + cases);
});

test("long randomised runs agree too", () => {
  // The exhaustive runs are three steps deep, which is enough to reach every
  // boundary but not enough to catch a stamp clock that drifts over a session.
  let seed = 20260814;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const looks = [null, { name: "A", champion: "X" }, { name: "A", champion: "Y" }, { name: "B", champion: null }];
  for (let run = 0; run < 200; run++) {
    const steps = [];
    for (let i = 0; i < 40; i++) {
      steps.push({ dt: rnd(2) ? rnd(70000) : DTS[rnd(DTS.length)], sighting: looks[rnd(looks.length)] });
    }
    const { fresh, legacy } = driveBoth(deckMemory, legacyDeckMemory, steps);
    assert.deepEqual(fresh.held, legacy.held);
    assert.deepEqual(fresh.writes, legacy.writes);
  }
});

test("both callers still configure the memory the way this test does", () => {
  /* The differential above proves the module; this is what keeps it pointed at
   * the real configuration. A `same` that stopped comparing the champion, or a
   * key that changed, would leave every assertion here passing about code
   * nothing runs. */
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

  const deckScan = read("capture/deck-scan.js");
  assert.match(deckScan, /key: "activeDeck"/);
  assert.match(deckScan, /held\.name === found\.name && held\.champion === found\.champion/);
  assert.match(deckScan, /isStored: \(stored\) => !!stored\.name/);

  const format = read("capture/match-format.js");
  assert.match(format, /key: "activeFormat"/);
  assert.match(format, /held\.format === found\.format/);
  assert.match(format, /isStored: \(stored\) => !!stored\.format/);
});
