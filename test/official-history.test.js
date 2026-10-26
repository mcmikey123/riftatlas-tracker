"use strict";

/* What the site's game history says, which rows get downloaded, and which of
 * our match records each one is.
 *
 * The rows below are the shape gameHistory:list returns, with the names, ids
 * and friend codes made up. Each judgement here fails silently when wrong: a
 * row never fetched is a replay that expires unseen, and a wrong link opens
 * somebody else's game from a match's own row.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const H = require("../official/history.js");

const NOW = 1793032000000;

function row(over) {
  const o = Object.assign(
    {
      key: "8BXV8:1793031014195:1:1793031045596",
      startedAt: 1793031045596,
      endedAt: 1793031809827,
      status: "ready",
      expiresAt: 1793053409827,
      full: true,
      me: "Alba",
      them: "Corin",
      winner: "plr_them",
    },
    over
  );
  return {
    id: "g_" + o.key,
    startedAt: o.startedAt,
    endedAt: o.endedAt,
    status: "completed",
    personalResult: null,
    winnerPlayerIds: [o.winner],
    gameNumber: 1,
    gameVariant: "duel",
    matchFormat: "bo1",
    replay: {
      gameKey: o.key,
      status: o.status,
      expiresAt: o.expiresAt,
      canExtend: true,
      fullInformation: o.full,
      canFork: true,
      canExtendDirectly: false,
    },
    players: [
      {
        playerId: "plr_me",
        name: o.me,
        score: 3,
        isYou: true,
        deckPrivate: false,
        legend: { name: "Kai'Sa, Daughter of the Void", cardCode: "OGN-247" },
      },
      {
        playerId: "plr_them",
        name: o.them,
        score: 8,
        friendCode: "0000000000",
        isYou: false,
        deckPrivate: false,
        legend: { name: "Riven, The Exile", cardCode: "RAD-149" },
      },
    ],
  };
}

const summary = (over) => H.summarise(row(over));

// ---- reading a row -------------------------------------------------------

test("a history row is reduced to the game, the room it was in, and both sides", () => {
  const s = summary();
  assert.equal(s.gameKey, "8BXV8:1793031014195:1:1793031045596");
  assert.equal(s.roomCode, "8BXV8");
  assert.equal(s.replayStatus, "ready");
  assert.equal(s.fullInformation, true);
  assert.equal(s.won, false);
  assert.deepEqual(s.you, {
    playerId: "plr_me",
    name: "Alba",
    score: 3,
    legend: "Kai'Sa, Daughter of the Void",
    cardCode: "OGN-247",
  });
  assert.equal(s.opponent.name, "Corin");
  assert.equal(s.opponent.legend, "Riven, The Exile");
  assert.equal("friendCode" in s.opponent, false, "the opponent's friend code is not kept");
});

test("isYou decides the sides, whichever order the players come in", () => {
  const r = row({ winner: "plr_me" });
  r.players.reverse();
  const s = H.summarise(r);
  assert.equal(s.you.name, "Alba");
  assert.equal(s.won, true);
});

test("a row that cannot be placed is dropped, not half-read", () => {
  const noKey = row();
  delete noKey.replay.gameKey;
  const noMe = row();
  noMe.players[0].isYou = false;
  assert.equal(H.summarise(noKey), null);
  assert.equal(H.summarise(noMe), null);
  assert.equal(H.summarise(null), null);
  assert.deepEqual(H.parsePage({ page: [noKey, row(), null] }).length, 1);
  assert.deepEqual(H.parsePage(null), []);
});

// ---- what to fetch -------------------------------------------------------

test("only a ready, full-information, unexpired replay not already on disk is fetched", () => {
  const ready = summary();
  const stored = summary({ key: "AAAAA:1:1:1" });
  const expiredStatus = summary({ key: "BBBBB:1:1:1", status: "expired" });
  const pastExpiry = summary({ key: "CCCCC:1:1:1", expiresAt: NOW - 1 });
  const publicOnly = summary({ key: "DDDDD:1:1:1", full: false });
  const preparing = summary({ key: "EEEEE:1:1:1", status: "processing" });
  const got = H.wanted([ready, stored, expiredStatus, pastExpiry, publicOnly, preparing], ["AAAAA:1:1:1"], NOW);
  assert.deepEqual(got.map((s) => s.gameKey), [ready.gameKey]);
});

test("a replay still being prepared asks for an early poll; an expired one does not", () => {
  assert.equal(H.pending([summary({ status: "processing" })], NOW), true);
  assert.equal(H.pending([summary({ status: "expired" })], NOW), false);
  assert.equal(H.pending([summary({ status: "processing", expiresAt: NOW - 1 })], NOW), false);
  assert.equal(H.pending([summary()], NOW), false);
});

// ---- linking to our records ----------------------------------------------

const match = (over) =>
  Object.assign(
    {
      id: "m1",
      roomCode: "8BXV8",
      opponentName: "Corin",
      // Ours is stamped when the board reads in_game, after the pre-game screens.
      startedAt: new Date(1793031045596 + 90 * 1000).toISOString(),
    },
    over
  );

test("a record is linked by its room code and a nearby start", () => {
  const links = H.linkToMatches([match()], [summary()]);
  assert.equal(links.get("m1").gameKey, "8BXV8:1793031014195:1:1793031045596");
});

test("the room code is compared without case", () => {
  assert.equal(H.linkToMatches([match({ roomCode: "8bxv8" })], [summary()]).size, 1);
});

test("the same room much later is not the same game", () => {
  const later = match({ startedAt: new Date(1793031045596 + 60 * 60 * 1000).toISOString() });
  assert.equal(H.linkToMatches([later], [summary()]).size, 0);
});

test("the games of a Bo3 in one room each find their own replay", () => {
  const g1 = summary({ key: "ROOM1:100:1:1793031000000", startedAt: 1793031000000 });
  const g2 = summary({ key: "ROOM1:100:2:1793031900000", startedAt: 1793031900000 });
  const m1 = match({ id: "a", roomCode: "ROOM1", startedAt: new Date(1793031000000 + 60000).toISOString() });
  const m2 = match({ id: "b", roomCode: "ROOM1", startedAt: new Date(1793031900000 + 60000).toISOString() });
  const links = H.linkToMatches([m2, m1], [g2, g1]);
  assert.equal(links.get("a").gameKey, g1.gameKey);
  assert.equal(links.get("b").gameKey, g2.gameKey);
});

test("one replay is never linked to two records", () => {
  const near = match({ id: "near" });
  const far = match({ id: "far", startedAt: new Date(1793031045596 + 5 * 60 * 1000).toISOString() });
  const links = H.linkToMatches([far, near], [summary()]);
  assert.deepEqual([...links.keys()], ["near"]);
});

test("without a room code the opponent's name links, in a tighter window", () => {
  const close = match({ roomCode: null });
  const loose = match({ roomCode: null, startedAt: new Date(1793031045596 + 6 * 60 * 1000).toISOString() });
  const other = match({ roomCode: null, opponentName: "Someone else" });
  assert.equal(H.linkToMatches([close], [summary()]).size, 1);
  assert.equal(H.linkToMatches([loose], [summary()]).size, 0);
  assert.equal(H.linkToMatches([other], [summary()]).size, 0);
});

test("a record with a room code is never linked by name to a different room", () => {
  assert.equal(H.linkToMatches([match({ roomCode: "ZZZZZ" })], [summary()]).size, 0);
});

// ---- the token -------------------------------------------------------------

const jwt = (payload) =>
  ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");

test("a token is usable until shortly before it expires", () => {
  assert.equal(H.tokenUsable(jwt({ exp: (NOW + 5 * 60 * 1000) / 1000 }), NOW), true);
  assert.equal(H.tokenUsable(jwt({ exp: (NOW + 10 * 1000) / 1000 }), NOW), false);
  assert.equal(H.tokenUsable(jwt({}), NOW), false);
  assert.equal(H.tokenUsable("not a token", NOW), false);
  assert.equal(H.tokenUsable(null, NOW), false);
});

// ---- the viewer ------------------------------------------------------------

test("the viewer URL carries the game key in its fragment, and reads back", () => {
  const key = "8BXV8:1793031014195:1:1793031045596";
  const url = new URL(H.viewerUrl(key));
  assert.equal(url.origin + url.pathname + url.search, "https://play.riftatlas.com/?replayFile=1");
  assert.equal(H.viewerKeyFrom(url.hash), key);
  assert.equal(H.viewerKeyFrom("#other=1"), null);
  assert.equal(H.viewerKeyFrom(""), null);
});

test("the site's replay viewer is recognised, the game itself is not", () => {
  assert.equal(H.isViewerPage({ pathname: "/", search: "?replayFile=1" }), true);
  assert.equal(H.isViewerPage({ pathname: "/en/replays/local", search: "" }), true);
  assert.equal(H.isViewerPage({ pathname: "/game", search: "" }), false);
  assert.equal(H.isViewerPage({ pathname: "/", search: "" }), false);
});

test("the file handed to the viewer is named the way the site names its download", () => {
  assert.equal(
    H.fileName("8BXV8:1793031014195:1:1793031045596"),
    "riftatlas-replay-8BXV8-1793031014195-1-1793031045596.json"
  );
});

test("only a riftatlas-replay body counts as a replay", () => {
  assert.equal(H.isReplay({ format: "riftatlas-replay", version: 2, nodes: [], root: { r: 0 } }), true);
  assert.equal(H.isReplay({ error: "not found" }), false);
  assert.equal(H.isReplay(null), false);
  assert.equal(H.isReplay([]), false);
});
