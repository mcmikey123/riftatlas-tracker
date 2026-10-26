/* Which match has an official replay, as the dashboard sees it.
 *
 * The linking itself is official/history.js's and is tested there. What is
 * pinned here is the index around it: rows listed once from the service
 * worker, links worked out on paint - and a link that SURVIVES its match
 * leaving the array, because deleting a match repaints before it tears the
 * match's data down, and forgetVisual finds the official replay to delete only
 * through the link it remembers.
 *
 * Its own file: view-replays.js keeps module-level state, and mount() here
 * would leak into the HTML tests in view-replays.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const sent = [];
const listed = [
  { gameKey: "8BXV8:1:1:1793031045596", summary: {
    gameKey: "8BXV8:1:1:1793031045596", roomCode: "8BXV8", startedAt: 1793031045596,
    opponent: { name: "Corin" } } },
];
global.document = { querySelector: () => null, addEventListener: () => {} };
global.chrome = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      sent.push(msg);
      if (msg.type === "ra:official:list") cb({ ok: true, replays: listed });
      else if (msg.type === "ra:visual:list") cb({ ok: true, replays: [] });
      else cb({ ok: true });
    },
  },
};

const R = require("../dashboard/view-replays.js");

let all = [{ id: "m1", roomCode: "8BXV8", startedAt: new Date(1793031045596 + 60000).toISOString() }];
R.mount({ matches: () => all, readOnly: () => false, render: () => R.ensureVisualIds(), readReplay: async () => null });

test("a match is linked to its official replay once the list has landed", () => {
  R.ensureVisualIds(); // lists, and the reply's render() links
  assert.equal(R.officialFor("m1"), "8BXV8:1:1:1793031045596");
  assert.equal(R.officialFor("nope"), null);
  assert.equal(sent.filter((m) => m.type === "ra:official:list").length, 1, "listed once, not per paint");
});

test("the link outlives the match leaving the array, so deleting it takes the replay too", () => {
  all = [];
  R.ensureVisualIds(); // the repaint a delete does before tearing down
  R.forgetVisual("m1");
  assert.ok(sent.some((m) => m.type === "ra:official:delete" && m.gameKey === "8BXV8:1:1:1793031045596"));
  assert.equal(R.officialFor("m1"), null);
});
