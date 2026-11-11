import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createApi, ApiError } from "../js/api.js";
import { newId, shiftKey } from "../js/logic.js";
import { createDatabase, databaseFetch } from "../dev/pg.mjs";

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let api;
before(async () => {
  const db = await createDatabase();
  api = createApi({ url: "https://example.test/", key: "test-key", fetchImpl: databaseFetch(db) });
});

const today = () => new Date().toISOString().slice(0, 10);
const window_ = () => ({ since: shiftKey(today(), -70), recentFrom: shiftKey(today(), -2) });

test("a full round trip through the real schema", async () => {
  const mars = await api.createPact({ name: "Mars", goalMl: 2000, tz: "Europe/Amsterdam" });
  assert.deepEqual(Object.keys(mars).sort(), ["code", "key", "memberId"]);

  assert.deepEqual(await api.peekPact(mars.code), { names: ["Mars"] });
  const sam = await api.joinPact({ code: mars.code, name: "Sam", goalMl: 2500, tz: "America/New_York" });

  const drinkId = newId();
  await api.logDrink(mars, { id: drinkId, ml: 500, at: new Date().toISOString(), day: today() });
  await api.sendNudge(mars, sam.memberId);
  await api.updateMember(sam, { name: "Sammy", goalMl: 3000, tz: "America/New_York" });

  const pact = await api.getPact({ code: mars.code, ...window_(), rev: null });
  assert.equal(pact.unchanged, false);
  assert.equal(pact.recentFrom, window_().recentFrom);
  assert.equal(pact.members.length, 2);
  const samRow = pact.members.find((m) => m.id === sam.memberId);
  assert.deepEqual([samRow.name, samRow.goal_ml, samRow.nudged_by], ["Sammy", 3000, mars.memberId]);
  assert.deepEqual(pact.entries.map((e) => [e.id, e.ml]), [[drinkId, 500]]);

  assert.deepEqual(await api.getPact({ code: mars.code, ...window_(), rev: pact.rev }), { unchanged: true, rev: pact.rev });

  await api.clearNudge(sam);
  await api.removeDrink(mars, drinkId);
  const after = await api.getPact({ code: mars.code, ...window_(), rev: pact.rev });
  assert.equal(after.entries.length, 0);
  assert.equal(after.members.find((m) => m.id === sam.memberId).nudged_by, null);

  const link = await api.createLinkCode(mars);
  assert.ok(link.expiresAt > Date.now());
  const second = await api.redeemLinkCode(link.linkCode);
  assert.equal(second.memberId, mars.memberId);
  assert.notEqual(second.key, mars.key);

  await api.leavePact(sam);
  await api.leavePact(mars);
  await assert.rejects(api.getPact({ code: mars.code, ...window_(), rev: null }), (e) => e.code === "wp_not_found");
});

test("database refusals surface as their code", async () => {
  await assert.rejects(
    api.logDrink({ code: "x", memberId: newId(), key: "nope" }, { id: newId(), ml: 250, at: new Date().toISOString(), day: today() }),
    (e) => e instanceof ApiError && e.code === "wp_auth",
  );
  await assert.rejects(api.joinPact({ code: "ZZZZZZZZZZ", name: "Sam", goalMl: 2000, tz: "UTC" }), (e) => e.code === "wp_not_found");
  await assert.rejects(api.createPact({ name: "", goalMl: 2000, tz: "UTC" }), (e) => e.code === "wp_invalid");
});

test("requests carry the project key and JSON", async () => {
  const calls = [];
  const spy = createApi({
    url: "https://example.test",
    key: "pub-key",
    fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonResponse(200, { names: [] }); },
  });
  await spy.peekPact("ABCDEFGHJK");
  assert.equal(calls[0].url, "https://example.test/rest/v1/rpc/wp_peek_pact");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.apikey, "pub-key");
  assert.equal(calls[0].init.headers.Authorization, "Bearer pub-key");
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_code: "ABCDEFGHJK" });
});

test("a dropped connection or a timeout reads as offline", async () => {
  const failing = createApi({ url: "https://example.test", key: "k", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(failing.peekPact("ABCDEFGHJK"), (e) => e.code === "network");

  const hanging = createApi({
    url: "https://example.test", key: "k", timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  await assert.rejects(hanging.peekPact("ABCDEFGHJK"), (e) => e.code === "network");
});

test("a struggling server reads as busy, which means try again later", async () => {
  const answer = (status, body = null) => createApi({ url: "https://example.test", key: "k", fetchImpl: async () => jsonResponse(status, body) });
  for (const status of [500, 502, 503, 408, 429]) {
    await assert.rejects(answer(status).peekPact("ABCDEFGHJK"), (e) => e.code === "busy", `status ${status}`);
  }
  await assert.rejects(answer(400, { message: "wp_busy" }).peekPact("ABCDEFGHJK"), (e) => e.code === "busy");
  await assert.rejects(answer(404).peekPact("ABCDEFGHJK"), (e) => e.code === "server");
  await assert.rejects(answer(401, { message: "Invalid API key" }).peekPact("ABCDEFGHJK"), (e) => e.code === "server");
});

test("unexpected answers are refused instead of trusted", async () => {
  const odd = (status, body) => createApi({ url: "https://example.test", key: "k", fetchImpl: async () => jsonResponse(status, body) });
  await assert.rejects(odd(400, { message: "something else" }).peekPact("ABCDEFGHJK"), (e) => e.code === "server");
  await assert.rejects(odd(200, { nope: true }).createPact({ name: "Mars", goalMl: 2000, tz: "UTC" }), (e) => e.code === "server");
  await assert.rejects(odd(200, "text").getPact({ code: "ABCDEFGHJK", since: "2026-01-01", recentFrom: "2026-01-02", rev: null }), (e) => e.code === "server");
  await assert.rejects(odd(200, { names: "Mars" }).peekPact("ABCDEFGHJK"), (e) => e.code === "server");
});

test("malformed rows are dropped from a pact", async () => {
  const body = {
    rev: 3, since: "2026-09-01", recent_from: "2026-11-09",
    members: [{ id: "a", name: "Mars", goal_ml: 2000, tz: "UTC", joined_at: "2026-11-01T00:00:00Z" }, { id: 7 }, null],
    days: [{ member_id: "a", day: "2026-11-01", total_ml: 500, goal_ml: 2000 }, { member_id: "a", day: 5 }],
    entries: [{ id: "e", member_id: "a", ml: 250, goal_ml: 2000, at: "2026-11-10T08:00:00Z", day: "2026-11-10" }, { id: "bad", ml: "lots" }],
  };
  const fake = createApi({ url: "https://example.test", key: "k", fetchImpl: async () => jsonResponse(200, body) });
  const pact = await fake.getPact({ code: "ABCDEFGHJK", since: "2026-09-01", recentFrom: "2026-11-09", rev: null });
  assert.deepEqual([pact.members.length, pact.days.length, pact.entries.length], [1, 1, 1]);
  assert.equal(pact.members[0].nudged_by, null);
});
