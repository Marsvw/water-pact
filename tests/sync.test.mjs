// The sync layer run against the real schema, with a switch to cut the "network".
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../js/api.js";
import { deviceTimeZone } from "../js/logic.js";
import { createStore, sanitizeSaved } from "../js/store.js";
import { createSync, refusalText } from "../js/sync.js";
import { createDatabase, databaseFetch, rpc } from "../dev/pg.mjs";

let db;
before(async () => { db = await createDatabase(); });

/** A phone: its own store and sync, talking to the shared database. */
function device() {
  // up: the connection works. busy: functions the server answers 503 for.
  // hold: function name -> promise; the answer is computed at once but delivered only when it resolves.
  const network = { up: true, calls: [], busy: new Set(), hold: new Map() };
  const live = databaseFetch(db);
  const api = createApi({
    url: "https://example.test",
    key: "k",
    fetchImpl: async (url, init) => {
      const fn = new URL(url).pathname.split("/").pop();
      network.calls.push({ fn, body: JSON.parse(init.body) });
      if (!network.up) throw new TypeError("offline");
      if (network.busy.has(fn)) return { ok: false, status: 503, json: async () => null };
      const response = await live(url, init);
      if (network.hold.has(fn)) await network.hold.get(fn);
      return response;
    },
  });
  const store = createStore(sanitizeSaved(null));
  const messages = [];
  const sync = createSync({ api, store, notify: (m) => messages.push(m) });
  return { api, store, sync, network, messages };
}

/** Lets queued sends and fetches run to completion. */
async function settle(dev) {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (dev.store.get().outbox.length === 0 || !dev.network.up) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function joinedDevice(name = "Mars") {
  const dev = device();
  const identity = await dev.api.createPact({ name, goalMl: 2000, tz: "UTC" });
  await dev.sync.adopt(identity);
  return { ...dev, identity };
}

const myEntries = (dev) => dev.store.get().pact.entries.filter((e) => e.member_id === dev.identity.memberId);

test("adopting an identity loads the pact", async () => {
  const dev = await joinedDevice();
  const { pact, identity } = dev.store.get();
  assert.equal(identity.code, dev.identity.code);
  assert.deepEqual(pact.members.map((m) => m.name), ["Mars"]);
  assert.deepEqual(pact.entries, []);
});

test("nothing is logged before the pact has loaded", () => {
  const dev = device();
  dev.store.set({ identity: { code: "ABCDEFGHJK", memberId: "m", key: "k" } });
  assert.equal(dev.sync.logDrink(250), false);
  assert.deepEqual(dev.store.get().outbox, []);
});

test("a drink is queued, sent, and then part of the pact", async () => {
  const dev = await joinedDevice();
  assert.equal(dev.sync.logDrink(249.6), true);
  assert.equal(dev.store.get().outbox.length, 1, "queued at once so the screen can show it");
  await settle(dev);
  assert.deepEqual(dev.store.get().outbox, []);
  assert.deepEqual(myEntries(dev).map((e) => e.ml), [250]);
  assert.equal(dev.store.get().online, true);
});

test("offline changes wait in order and sync when the connection returns", async () => {
  const dev = await joinedDevice();
  dev.network.up = false;
  dev.sync.logDrink(250);
  dev.sync.logDrink(500);
  await settle(dev);
  assert.equal(dev.store.get().online, false);
  assert.equal(dev.store.get().outbox.length, 2);
  assert.deepEqual(myEntries(dev), [], "the server copy is untouched while offline");

  const firstQueued = dev.store.get().outbox[0].id;
  dev.sync.removeDrink(firstQueued);
  assert.equal(dev.store.get().outbox.length, 3);

  dev.network.up = true;
  await dev.sync.flush();
  assert.deepEqual(dev.store.get().outbox, []);
  assert.deepEqual(myEntries(dev).map((e) => e.ml), [500]);
  assert.equal(dev.store.get().online, true);
});

test("a retry after a dropped reply does not double-log", async () => {
  const dev = await joinedDevice();
  dev.sync.logDrink(250);
  await settle(dev);
  const [sent] = myEntries(dev);
  // The same change arriving twice, as it would if the first reply never came back.
  dev.store.set({ outbox: [{ opId: "retry", type: "log", id: sent.id, ml: 250, goalMl: 2000, at: sent.at, day: sent.day }] });
  await dev.sync.flush();
  assert.equal(myEntries(dev).length, 1);
});

test("a change the server refuses is dropped with a message and never shown as saved", async () => {
  const dev = await joinedDevice();
  dev.store.set({ outbox: [{ opId: "bad", type: "log", id: "11111111-1111-4111-8111-111111111111", ml: 99999, goalMl: 2000, at: new Date().toISOString(), day: new Date().toISOString().slice(0, 10) }] });
  await dev.sync.flush();
  assert.deepEqual(dev.store.get().outbox, []);
  assert.deepEqual(myEntries(dev), []);
  assert.deepEqual(dev.messages, [refusalText("wp_invalid")]);
});

test("the daily cap is enforced before queueing", async () => {
  const dev = await joinedDevice();
  const day = new Date().toISOString().slice(0, 10);
  const entries = Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, member_id: dev.identity.memberId, ml: 10, goal_ml: 2000, at: new Date().toISOString(), day }));
  dev.store.set({ pact: { ...dev.store.get().pact, entries } });
  assert.equal(dev.sync.logDrink(250), false);
  assert.deepEqual(dev.messages, [refusalText("wp_limit")]);
});

test("a friend's changes arrive on the next refresh, and an unchanged pact is not re-sent", async () => {
  const mars = await joinedDevice();
  const sam = device();
  const samIdentity = await sam.api.joinPact({ code: mars.identity.code, name: "Sam", goalMl: 2500, tz: "UTC" });
  await sam.sync.adopt(samIdentity);
  sam.identity = samIdentity;
  sam.sync.logDrink(750);
  await settle(sam);

  await mars.sync.refresh();
  const pact = mars.store.get().pact;
  assert.deepEqual(pact.members.map((m) => m.name).sort(), ["Mars", "Sam"]);
  assert.deepEqual(pact.entries.map((e) => e.ml), [750]);

  mars.network.calls.length = 0;
  await mars.sync.refresh();
  assert.equal(mars.store.get().pact, pact, "same object: nothing was replaced");
  assert.equal(mars.network.calls[0].body.p_rev, pact.rev);
});

test("profile, nudge and clear-nudge go straight to the server", async () => {
  const mars = await joinedDevice();
  const sam = device();
  sam.identity = await sam.api.joinPact({ code: mars.identity.code, name: "Sam", goalMl: 2500, tz: "UTC" });
  await sam.sync.adopt(sam.identity);

  assert.deepEqual(await mars.sync.saveProfile({ name: "Mars W", goalMl: 3000 }), { ok: true });
  assert.equal(await mars.sync.sendNudge(sam.identity.memberId), true);
  await sam.sync.refresh();
  const samRow = () => sam.store.get().pact.members.find((m) => m.id === sam.identity.memberId);
  assert.equal(samRow().nudged_by, mars.identity.memberId);
  assert.equal(sam.store.get().pact.members.find((m) => m.id === mars.identity.memberId).name, "Mars W");

  assert.equal(await sam.sync.clearNudge(), true);
  assert.equal(samRow().nudged_by, null);
});

test("a direct change that fails reports why and changes nothing", async () => {
  const dev = await joinedDevice();
  // Saving a profile hands the reason back, so the settings sheet can show it in place.
  assert.deepEqual(await dev.sync.saveProfile({ name: "", goalMl: 2000 }), { ok: false, message: refusalText("wp_invalid") });
  assert.deepEqual(dev.messages, []);
  dev.network.up = false;
  assert.equal(await dev.sync.sendNudge("someone"), false);
  assert.deepEqual(dev.messages, [refusalText("network")]);
});

test("a busy server keeps the change queued and is not reported as offline", async () => {
  const dev = await joinedDevice();
  dev.network.busy.add("wp_log_drink");
  dev.sync.logDrink(250);
  await settle(dev);
  await dev.sync.flush();
  const state = dev.store.get();
  assert.equal(state.outbox.length, 1, "kept for a later try");
  assert.equal(state.online, true);
  assert.equal(state.trouble, true);
  assert.deepEqual(dev.messages, []);

  dev.network.busy.clear();
  await dev.sync.flush();
  assert.deepEqual(dev.store.get().outbox, []);
  assert.equal(dev.store.get().trouble, false);
  assert.deepEqual(myEntries(dev).map((e) => e.ml), [250]);
});

test("a change the server can never take stops blocking the queue after repeated tries", async () => {
  const dev = await joinedDevice();
  dev.network.busy.add("wp_remove_drink");
  dev.sync.removeDrink("11111111-1111-4111-8111-111111111111");
  dev.sync.logDrink(500);
  for (let i = 0; i < 10; i++) await dev.sync.flush();
  assert.deepEqual(dev.store.get().outbox, []);
  assert.deepEqual(myEntries(dev).map((e) => e.ml), [500], "the drink queued behind it went through");
  assert.equal(dev.messages.length, 1);
});

test("an older answer still in flight cannot undo a drink that was just saved", async () => {
  const dev = await joinedDevice();
  let release;
  dev.network.hold.set("wp_get_pact", new Promise((resolve) => { release = resolve; }));
  const poll = dev.sync.refresh({ force: true }); // computed now, before the drink exists; delivered later

  const lost = [];
  let saved = false;
  dev.store.subscribe((state) => {
    if (!state.pact) return;
    const present = state.pact.entries.some((e) => e.ml === 750);
    if (present) saved = true;
    if (saved && !present && state.outbox.length === 0) lost.push(state.pact.rev);
  });

  dev.sync.logDrink(750);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(saved, true, "the accepted drink is folded into the local copy");

  dev.network.hold.clear();
  release();
  await poll;
  await settle(dev);
  assert.deepEqual(lost, [], "the drink never disappears from the screen");
  assert.deepEqual(myEntries(dev).map((e) => e.ml), [750]);
});

test("switching identity while a fetch is in flight still loads the new pact", async () => {
  const first = await joinedDevice("First");
  const other = await first.api.createPact({ name: "Second", goalMl: 2500, tz: "UTC" });
  let release;
  first.network.hold.set("wp_get_pact", new Promise((resolve) => { release = resolve; }));
  const stale = first.sync.refresh({ force: true });
  first.sync.signOut();
  const adopting = first.sync.adopt(other);
  first.network.hold.clear();
  release();
  await Promise.all([stale, adopting]);
  const { pact, identity } = first.store.get();
  assert.equal(identity.code, other.code);
  assert.deepEqual(pact.members.map((m) => m.name), ["Second"]);
});

test("a phone that changed time zone tells the pact, once", async () => {
  const dev = await joinedDevice(); // joined as UTC
  await settle(dev);
  await dev.sync.refresh({ force: true });
  await settle(dev);
  const mine = dev.store.get().pact.members[0];
  assert.equal(mine.tz, deviceTimeZone());
  const updates = dev.network.calls.filter((c) => c.fn === "wp_update_member").length;
  assert.ok(updates <= 1, `sent ${updates} time zone updates`);
});

test("leaving signs this device out and removes the member", async () => {
  const dev = await joinedDevice();
  assert.equal(await dev.sync.leave(), true);
  const state = dev.store.get();
  assert.deepEqual([state.identity, state.pact, state.outbox], [null, null, []]);
  await assert.rejects(rpc(db, "wp_peek_pact", { p_code: dev.identity.code }), /wp_not_found/);
});

test("leaving while offline keeps you in the pact", async () => {
  const dev = await joinedDevice();
  dev.network.up = false;
  assert.equal(await dev.sync.leave(), false);
  assert.ok(dev.store.get().identity);
});

test("a device whose key stops working is signed out with an explanation", async () => {
  const dev = await joinedDevice();
  dev.store.set({ identity: { ...dev.identity, key: "revoked" } });
  dev.sync.logDrink(250);
  await settle(dev);
  assert.equal(dev.store.get().identity, null);
  assert.match(dev.store.get().notice, /no longer linked/);
});

test("being removed from the pact, or the pact vanishing, signs the device out", async () => {
  const mars = await joinedDevice();
  const sam = device();
  sam.identity = await sam.api.joinPact({ code: mars.identity.code, name: "Sam", goalMl: 2500, tz: "UTC" });
  await sam.sync.adopt(sam.identity);

  // Sam leaves from another device; this one finds out on its next refresh.
  await mars.api.leavePact(sam.identity);
  await sam.sync.refresh({ force: true });
  assert.equal(sam.store.get().identity, null);
  assert.match(sam.store.get().notice, /no longer in that pact/);

  await mars.api.leavePact(mars.identity);
  await mars.sync.refresh({ force: true });
  assert.equal(mars.store.get().identity, null);
  assert.match(mars.store.get().notice, /no longer exists/);
});

test("refusal messages always say something", () => {
  assert.ok(refusalText("wp_full").length > 0);
  assert.equal(refusalText("something-new"), refusalText("server"));
});
