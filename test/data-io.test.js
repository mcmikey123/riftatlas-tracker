/* Getting the whole history out of this browser, and back into it.
 *
 * The file FORMAT is bundle.js and is tested in bundle.test.js. What is tested
 * here is what surrounds it, where the failure modes are not "the file is
 * malformed" but "the wrong data moved":
 *
 *   the CSV's columns and their order - it is fed to spreadsheets, and a
 *   derived column landing under the wrong header is silently wrong;
 *   what an import writes, which is a MERGE - a stored match the file has never
 *   heard of must survive it;
 *   which storage keys a clear removes, which is the only irreversible one. The
 *   archive path deliberately spares anything the file it just wrote does not
 *   hold, because for those matches the extension is still the only copy.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { fmtDuration } = require("../dashboard/format.js");
const { csvCell } = require("../dashboard/bundle.js");
const { analyse } = require("../dashboard/analysis.js");
const IO = require("../dashboard/data-io.js");

// ---- the CSV -----------------------------------------------------------

/** legacy.js's CSV builder as it stood before the move. */
function referenceCsv(bundle) {
  const cols = ["startedAt","endedAt","durationMs","mode","roomCode","myName","opponentName","myLegend","myChampion","opponentLegend","opponentChampion","myScore","opponentScore","turns","result","resultSource","endReason","wentFirst","deckName","deckSource","seriesId","seriesGame","seriesFormat","seriesSource","notes"];
  const extra = ["duration","verdict","myCommits","oppCommits","myConquers","oppConquers","myTrashed","oppTrashed","logLines"];
  const lines = [cols.concat(extra).join(",")].concat(
    bundle.matches.map((m) => {
      const a = analyse(m);
      const vals = cols.map((c) => csvCell(m[c]));
      vals.push(
        csvCell(fmtDuration(m.durationMs)), csvCell(a.verdict),
        csvCell(a.self.commit), csvCell(a.opponent.commit),
        csvCell(a.self.conquer), csvCell(a.opponent.conquer),
        csvCell(a.self.trash), csvCell(a.opponent.trash), csvCell(a.lines)
      );
      return vals.join(",");
    })
  );
  return lines.join("\n");
}

const logLine = (actor, text) => ({ t: "20:14", actor, text });

const fullMatch = (over) =>
  Object.assign(
    {
      id: "m1",
      startedAt: "2026-05-02T20:14:00Z",
      endedAt: "2026-05-02T20:31:00Z",
      durationMs: 1_020_000,
      mode: "ranked",
      roomCode: "AB12",
      myName: "me",
      opponentName: "them",
      myLegend: "Alba, the Dawnbreaker",
      myChampion: "Alba",
      opponentLegend: "Corin, Tidecaller",
      opponentChampion: "Corin",
      myScore: 8,
      opponentScore: 5,
      turns: 14,
      result: "win",
      resultSource: "auto",
      endReason: "score",
      deckName: "Hollowmark Aggro",
      deckSource: "manual",
      seriesId: "s1",
      seriesGame: 2,
      seriesFormat: "bo3",
      seriesSource: "manual",
      notes: "close one",
      log: [
        logLine("self", "moved Unit to Battlefield"),
        logLine("opponent", "conquered the Ridge and scored 3"),
        logLine("self", "sent Card to trash"),
      ],
    },
    over
  );

test("the CSV is exactly what the pre-move export wrote, plus the wentFirst column", () => {
  const bundles = [
    { matches: [] },
    { matches: [fullMatch()] },
    {
      matches: [
        fullMatch(),
        // A live match: half the fields are missing, and the derived columns
        // have to line up all the same.
        { id: "m2", startedAt: "2026-05-03T09:00:00Z" },
        // A hostile display name, an embedded comma, a quote and a newline.
        fullMatch({ id: "m3", opponentName: '=cmd|calc', notes: 'he said "hi",\nthen left' }),
        fullMatch({ id: "m4", durationMs: null, myScore: -3, log: [] }),
      ],
    },
  ];
  for (const bundle of bundles) {
    assert.equal(IO.csvText(bundle), referenceCsv(bundle));
  }
});

test("every column has a header and every row has every column", () => {
  const csv = IO.csvText({ matches: [fullMatch(), { id: "m2" }] });
  const rows = csv.split("\n");
  const width = IO.CSV_COLUMNS.length + IO.CSV_DERIVED.length;
  assert.equal(rows[0].split(",").length, width);
  // Row 2 carries a quoted cell with no comma in it, so a plain split is safe
  // for this fixture and the width is what is being checked.
  assert.equal(rows[2].split(",").length, width);
  assert.equal(rows.length, 3, "a header and one row per match");
});

test("the derived columns are the game log, in the order the header names them", () => {
  /* Split on commas, so the fixture carries none inside a cell - a legend field
   * ("Alba, the Dawnbreaker") is quoted per RFC 4180 and would shift every
   * index after it, which is a property of the parser here rather than of the
   * export. */
  const csv = IO.csvText({ matches: [fullMatch({ myLegend: "Alba", opponentLegend: "Corin" })] });
  const header = csv.split("\n")[0].split(",");
  const row = csv.split("\n")[1].split(",");
  const at = (name) => row[header.indexOf(name)];
  assert.equal(at("duration"), "17:00");
  assert.equal(at("myCommits"), "1");
  assert.equal(at("oppConquers"), "1");
  assert.equal(at("myTrashed"), "1");
  assert.equal(at("logLines"), "3");
});

test("a match with no log still exports, with zeroed derived columns", () => {
  const csv = IO.csvText({ matches: [{ id: "m1", result: "win" }] });
  const header = csv.split("\n")[0].split(",");
  const row = csv.split("\n")[1].split(",");
  assert.equal(row[header.indexOf("logLines")], "0");
  assert.equal(row[header.indexOf("duration")], "–", "an untimed match is not 0:00");
});

test("an export with no matches is a header and nothing else", () => {
  assert.equal(IO.csvText({ matches: [] }).split("\n").length, 1);
  assert.equal(IO.csvText({}).split("\n").length, 1);
});

// ---- what an import writes ---------------------------------------------

const bundle = (matches, deckCards) => ({ matches, deckCards: deckCards || {} });

test("an import merges by id and keeps stored matches the file never saw", () => {
  /* The file is not the whole truth: importing a friend's export, or an old
   * one of your own, must not delete the matches played since. */
  const { writes } = IO.bundleWrites(
    bundle([{ id: "a", result: "loss" }, { id: "new" }]),
    [{ id: "a", result: "win" }, { id: "kept" }]
  );
  assert.deepEqual(
    writes.matches.map((m) => m.id).sort(),
    ["a", "kept", "new"]
  );
  assert.equal(
    writes.matches.find((m) => m.id === "a").result,
    "loss",
    "the file's copy wins for a match in both"
  );
});

test("logs are lifted out of the records and into their own keys", () => {
  // `matches` is rewritten every three seconds during a live game, so it holds
  // lean records - a log inline in there is ~21 KB per match of rewrite.
  const log = [logLine("self", "played a card")];
  const { writes, logs } = IO.bundleWrites(bundle([{ id: "a", log }]), []);
  assert.deepEqual(writes.log_a, { id: "a", log });
  assert.equal(writes.matches[0].log, undefined, "no record keeps its log inline");
  assert.deepEqual(logs, [["a", log]], "and the cache is told, so the row can open at once");
});

test("an empty log writes no key at all", () => {
  // A key holding an empty array would claim the log was captured and empty.
  const { writes, logs } = IO.bundleWrites(bundle([{ id: "a", log: [] }, { id: "b" }]), []);
  assert.deepEqual(Object.keys(writes), ["matches"]);
  assert.deepEqual(logs, []);
});

test("card codes are carried, and only when there are any", () => {
  const { writes } = IO.bundleWrites(
    bundle([{ id: "a" }], { a: ["c1", "c2"], b: [], c: null }),
    []
  );
  assert.deepEqual(writes.deckcards_a, { id: "a", codes: ["c1", "c2"] });
  assert.ok(!("deckcards_b" in writes));
  assert.ok(!("deckcards_c" in writes));
});

test("a record with no id is skipped rather than written under undefined", () => {
  const { writes } = IO.bundleWrites(bundle([{ result: "win" }, null, { id: "a" }]), []);
  assert.deepEqual(writes.matches.map((m) => m.id), ["a"]);
});

test("a stored record with no id is not carried through the merge either", () => {
  const { writes } = IO.bundleWrites(bundle([{ id: "a" }]), [{ result: "win" }, { id: "b" }]);
  assert.deepEqual(writes.matches.map((m) => m.id).sort(), ["a", "b"]);
});

// ---- what a clear removes ----------------------------------------------

const KEYS = [
  "matches",
  "settings",
  "shares",
  "log_a",
  "log_b",
  "deckcards_a",
  "deckcards_b",
  "replay_a",
  "log_odd_id_with_underscores",
];

test("clearing everything takes the logs, the card lists and the share records", () => {
  const keys = IO.clearableKeys(KEYS, null);
  assert.deepEqual(keys.sort(), [
    "deckcards_a",
    "deckcards_b",
    "log_a",
    "log_b",
    "log_odd_id_with_underscores",
    "shares",
  ]);
  assert.ok(!keys.includes("matches"), "the match array is rewritten, not removed");
  assert.ok(!keys.includes("settings"), "settings are this browser's, not this history's");
});

test("archive & clear spares anything the archive file does not hold", () => {
  /* A match that finished while the confirm was open is not in the file that
   * was just written, so clearing its log would destroy the only copy. */
  const keys = IO.clearableKeys(KEYS, new Set(["a"]));
  assert.deepEqual(keys.sort(), ["deckcards_a", "log_a", "shares"]);
});

test("a match id containing underscores is still recognised", () => {
  // The id is everything after the FIRST underscore, which is what makes
  // "log_odd_id_with_underscores" the log of "odd_id_with_underscores".
  const archived = new Set(["odd_id_with_underscores"]);
  assert.deepEqual(IO.clearableKeys(KEYS, archived).sort(), ["log_odd_id_with_underscores", "shares"]);
});

test("the share records go with either clear, archived or not", () => {
  /* Each record holds a decryption key. A wipe that leaves every key this
   * browser ever made behind is not the clean slate the button offers - and the
   * confirms say so. */
  assert.ok(IO.clearableKeys(["shares"], new Set()).includes("shares"));
  assert.ok(IO.clearableKeys(["shares"], null).includes("shares"));
});

test("clearing says what it kept, and only when it kept something", () => {
  assert.match(IO.clearedMessage(0), /^Local data cleared\./);
  assert.match(IO.clearedMessage(1), /1 match finished after the archive was written and was kept/);
  assert.match(IO.clearedMessage(3), /3 matches .* and were kept/);
});

// ---- what the confirms promise -----------------------------------------

test("the archive confirm states what was written before offering to wipe", () => {
  const c = IO.archiveConfirm(207, "4.1");
  assert.equal(c.sub, "Archive downloaded — 207 matches, 4.1 MB");
  assert.ok(c.danger);
  assert.match(c.body, /Check it is in your Downloads folder first/);
  assert.match(c.body, /does not carry share links/, "the one thing the file cannot restore");
});

test("clear-all points at the path that keeps a copy", () => {
  const c = IO.clearAllConfirm();
  assert.ok(c.danger);
  assert.match(c.body, /Archive &amp; clear/);
  assert.match(c.body, /no copy taken/);
});
