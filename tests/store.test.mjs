import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, loadSaved, persist, persistedChanged, sanitizeSaved } from "../js/store.js";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    dump: () => Object.fromEntries(data),
  };
}

const IDENTITY = { code: "ABCDEFGHJK", memberId: "m1", key: "k1" };
const PACT = { rev: 2, since: "2026-09-01", recentFrom: "2026-11-09", members: [], days: [], entries: [] };

test("a first visit gets sensible defaults", () => {
  const state = sanitizeSaved(null);
  assert.equal(state.identity, null);
  assert.equal(state.pact, null);
  assert.deepEqual(state.outbox, []);
  assert.ok(["ml", "oz"].includes(state.unit));
  assert.ok(state.bottleMl > 0);
  assert.equal(state.online, true);
  assert.ok(Object.isFrozen(state));
});

test("saved state round-trips through storage", () => {
  const storage = memoryStorage();
  const outbox = [
    { opId: "o1", type: "log", id: "d1", ml: 250, goalMl: 2000, at: "2026-11-11T08:00:00Z", day: "2026-11-11" },
    { opId: "o2", type: "remove", id: "d0" },
  ];
  const state = { ...sanitizeSaved(null), identity: IDENTITY, unit: "oz", bottleMl: 600, outbox, pact: PACT, installDismissed: true };
  assert.equal(persist(state, storage), true);
  const loaded = loadSaved(storage);
  assert.deepEqual(loaded.identity, IDENTITY);
  assert.equal(loaded.unit, "oz");
  assert.equal(loaded.bottleMl, 600);
  assert.deepEqual(loaded.outbox, outbox);
  assert.deepEqual(loaded.pact, PACT);
  assert.equal(loaded.installDismissed, true);
});

test("transient flags are not saved", () => {
  const storage = memoryStorage();
  persist({ ...sanitizeSaved(null), online: false, notice: "hello" }, storage);
  const raw = JSON.parse(storage.dump()["waterpact.v2"]);
  assert.equal("online" in raw, false);
  assert.equal("notice" in raw, false);
});

test("damaged or hostile saved data is cleaned, not trusted", () => {
  const state = sanitizeSaved({
    identity: { code: "ABCDEFGHJK", memberId: 7 },
    unit: "gallons",
    bottleMl: 999999,
    outbox: [{ opId: "o1", type: "log", id: "d1", ml: "lots" }],
    pact: { rev: "x" },
    installDismissed: "yes",
  });
  assert.equal(state.identity, null);
  assert.ok(["ml", "oz"].includes(state.unit));
  assert.ok(state.bottleMl <= 3000);
  assert.deepEqual(state.outbox, []);
  assert.equal(state.pact, null);
  assert.equal(state.installDismissed, false);
});

test("without an identity, a leftover queue and cached pact are dropped", () => {
  const state = sanitizeSaved({ outbox: [{ opId: "o", type: "remove", id: "d" }], pact: PACT });
  assert.deepEqual(state.outbox, []);
  assert.equal(state.pact, null);
});

test("invalid queued changes are filtered out one by one", () => {
  const state = sanitizeSaved({
    identity: IDENTITY,
    outbox: [
      { opId: "o1", type: "remove", id: "d1" },
      { opId: "o2", type: "mystery", id: "d2" },
      null,
      { opId: "o3", type: "log", id: "d3", ml: 250, goalMl: 2000, at: "2026-11-11T08:00:00Z", day: "2026-11-11", extra: "dropped" },
    ],
  });
  assert.deepEqual(state.outbox.map((o) => o.opId), ["o1", "o3"]);
  assert.equal("extra" in state.outbox[1], false);
});

test("blocked or broken storage does not crash the app", () => {
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(loadSaved(throwing).identity, null);
  assert.equal(persist(sanitizeSaved(null), throwing), false);
  assert.equal(loadSaved(memoryStorage({ "waterpact.v2": "{not json" })).identity, null);
});

test("the store replaces state instead of changing it, and tells listeners", () => {
  const store = createStore({ unit: "ml", count: 1 });
  const before = store.get();
  const seen = [];
  const stop = store.subscribe((state, prev) => seen.push([state.count, prev.count]));
  store.set({ count: 2 });
  assert.equal(before.count, 1, "the old object is untouched");
  assert.equal(store.get().count, 2);
  assert.ok(Object.isFrozen(store.get()));
  stop();
  store.set({ count: 3 });
  assert.deepEqual(seen, [[2, 1]]);
});

test("only lasting changes count as worth saving", () => {
  const a = sanitizeSaved(null);
  assert.equal(persistedChanged(a, { ...a, online: false }), false);
  assert.equal(persistedChanged(a, { ...a, unit: a.unit === "ml" ? "oz" : "ml" }), true);
});
