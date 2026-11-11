import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, rpc, asOwner } from "../dev/pg.mjs";

let db;
before(async () => { db = await createDatabase(); });

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function newPact(name = "Mars", goal = 2000) {
  return rpc(db, "wp_create_pact", { p_name: name, p_goal_ml: goal, p_tz: "Europe/Amsterdam" });
}
async function join(code, name = "Sam", goal = 2500) {
  return rpc(db, "wp_join_pact", { p_code: code, p_name: name, p_goal_ml: goal, p_tz: "America/New_York" });
}
async function getPact(code, rev = null) {
  return rpc(db, "wp_get_pact", { p_code: code, p_since: daysAgo(70), p_recent_from: daysAgo(2), p_rev: rev });
}
async function log(creds, ml = 250, id = randomUUID(), day = today()) {
  await rpc(db, "wp_log_drink", {
    p_member_id: creds.member_id, p_key: creds.member_key, p_id: id, p_ml: ml,
    p_at: new Date().toISOString(), p_day: day,
  });
  return id;
}
const memberOf = (pact, creds) => pact.members.find((m) => m.id === creds.member_id);
const rejects = (promise, message) => assert.rejects(promise, (e) => { assert.equal(e.message, message); return true; });

test("creating a pact returns an invite code and device credentials", async () => {
  const creds = await newPact();
  assert.match(creds.code, /^[A-HJKMNP-Z2-9]{10}$/);
  assert.match(creds.member_id, /^[0-9a-f-]{36}$/);
  assert.ok(creds.member_key.length >= 32);
});

test("a friend joins with the code and both members are listed", async () => {
  const mars = await newPact();
  const sam = await join(mars.code.toLowerCase().replace(/^(.{5})/, "$1-"));
  const pact = await getPact(mars.code);
  assert.deepEqual(pact.members.map((m) => m.name).sort(), ["Mars", "Sam"]);
  assert.equal(memberOf(pact, sam).name, "Sam");
  assert.equal(memberOf(pact, sam).goal_ml, 2500);
  assert.equal(memberOf(pact, sam).tz, "America/New_York");
});

test("peek shows who is in the pact without joining", async () => {
  const mars = await newPact();
  const peek = await rpc(db, "wp_peek_pact", { p_code: mars.code });
  assert.deepEqual(peek.names, ["Mars"]);
});

test("unknown codes are rejected", async () => {
  await rejects(join("ZZZZZZZZZZ"), "wp_not_found");
  await rejects(getPact("ZZZZZZZZZZ"), "wp_not_found");
  await rejects(rpc(db, "wp_peek_pact", { p_code: "nope" }), "wp_not_found");
});

test("names and goals are validated", async () => {
  await rejects(newPact("   ", 2000), "wp_invalid");
  await rejects(newPact("Mars", 100), "wp_invalid");
  await rejects(newPact("Mars", 9000), "wp_invalid");
  await rejects(newPact("x".repeat(25), 2000), "wp_invalid");
});

test("a pact holds at most eight people", async () => {
  const mars = await newPact();
  for (let i = 0; i < 7; i++) await join(mars.code, `Friend ${i}`);
  await rejects(join(mars.code, "One too many"), "wp_full");
});

test("drinks need the right device key", async () => {
  const mars = await newPact();
  await rejects(log({ member_id: mars.member_id, member_key: "wrong" }), "wp_auth");
  await rejects(log({ member_id: randomUUID(), member_key: mars.member_key }), "wp_auth");
});

test("a logged drink shows up in today's entries and bumps the revision", async () => {
  const mars = await newPact();
  const before = await getPact(mars.code);
  const id = await log(mars, 500);
  const after = await getPact(mars.code);
  assert.ok(after.rev > before.rev);
  assert.equal(after.entries.length, 1);
  assert.deepEqual(
    { id: after.entries[0].id, member_id: after.entries[0].member_id, ml: after.entries[0].ml, day: after.entries[0].day, goal_ml: after.entries[0].goal_ml },
    { id, member_id: mars.member_id, ml: 500, day: today(), goal_ml: 2000 },
  );
});

test("logging the same drink twice stores it once", async () => {
  const mars = await newPact();
  const id = await log(mars, 250);
  await log(mars, 250, id);
  const pact = await getPact(mars.code);
  assert.equal(pact.entries.length, 1);
});

test("drink amounts and days are validated", async () => {
  const mars = await newPact();
  await rejects(log(mars, 5), "wp_invalid");
  await rejects(log(mars, 3001), "wp_invalid");
  await rejects(log(mars, 250, randomUUID(), daysAgo(30)), "wp_invalid");
});

test("older days come back as daily totals with the goal in force that day", async () => {
  const mars = await newPact();
  await log(mars, 500, randomUUID(), daysAgo(5));
  await log(mars, 750, randomUUID(), daysAgo(5));
  const pact = await getPact(mars.code);
  assert.equal(pact.entries.length, 0);
  assert.deepEqual(pact.days, [{ member_id: mars.member_id, day: daysAgo(5), total_ml: 1250, goal_ml: 2000 }]);
});

test("an unchanged pact answers with just its revision", async () => {
  const mars = await newPact();
  const first = await getPact(mars.code);
  const second = await getPact(mars.code, first.rev);
  assert.deepEqual(second, { rev: first.rev, unchanged: true });
});

test("only the owner of a drink can remove it", async () => {
  const mars = await newPact();
  const sam = await join(mars.code);
  const id = await log(mars, 250);
  await rpc(db, "wp_remove_drink", { p_member_id: sam.member_id, p_key: sam.member_key, p_id: id });
  assert.equal((await getPact(mars.code)).entries.length, 1);
  await rpc(db, "wp_remove_drink", { p_member_id: mars.member_id, p_key: mars.member_key, p_id: id });
  assert.equal((await getPact(mars.code)).entries.length, 0);
});

test("profile updates change name, goal and time zone", async () => {
  const mars = await newPact();
  await rpc(db, "wp_update_member", {
    p_member_id: mars.member_id, p_key: mars.member_key, p_name: "  Mars  W ", p_goal_ml: 3000, p_tz: "Asia/Tokyo",
  });
  const me = (await getPact(mars.code)).members[0];
  assert.deepEqual([me.name, me.goal_ml, me.tz], ["Mars W", 3000, "Asia/Tokyo"]);
});

test("a nudge lands on the friend and clears when they drink", async () => {
  const mars = await newPact();
  const sam = await join(mars.code);
  await rpc(db, "wp_send_nudge", { p_member_id: mars.member_id, p_key: mars.member_key, p_to: sam.member_id });
  let samRow = memberOf(await getPact(mars.code), sam);
  assert.equal(samRow.nudged_by, mars.member_id);
  assert.ok(samRow.nudged_at);
  await log(sam, 250);
  samRow = memberOf(await getPact(mars.code), sam);
  assert.equal(samRow.nudged_by, null);
  assert.equal(samRow.nudged_at, null);
});

test("nudges cannot cross pacts or target yourself", async () => {
  const mars = await newPact();
  const stranger = await newPact("Stranger");
  await rejects(
    rpc(db, "wp_send_nudge", { p_member_id: mars.member_id, p_key: mars.member_key, p_to: stranger.member_id }),
    "wp_invalid",
  );
  await rejects(
    rpc(db, "wp_send_nudge", { p_member_id: mars.member_id, p_key: mars.member_key, p_to: mars.member_id }),
    "wp_invalid",
  );
});

test("a link code moves an identity to a second device exactly once", async () => {
  const mars = await newPact();
  const { link_code } = await rpc(db, "wp_create_link_code", { p_member_id: mars.member_id, p_key: mars.member_key });
  assert.match(link_code, /^[A-HJKMNP-Z2-9]{10}$/);
  const second = await rpc(db, "wp_redeem_link_code", { p_link_code: link_code.toLowerCase() });
  assert.equal(second.member_id, mars.member_id);
  assert.equal(second.code, mars.code);
  assert.notEqual(second.member_key, mars.member_key);
  await log({ member_id: second.member_id, member_key: second.member_key }, 250);
  await log(mars, 250);
  assert.equal((await getPact(mars.code)).entries.length, 2);
  await rejects(rpc(db, "wp_redeem_link_code", { p_link_code: link_code }), "wp_not_found");
});

test("expired link codes do not work", async () => {
  const mars = await newPact();
  const { link_code } = await rpc(db, "wp_create_link_code", { p_member_id: mars.member_id, p_key: mars.member_key });
  await asOwner(db, "update water_pact.link_codes set expires_at = now() - interval '1 minute' where code = $1", [link_code]);
  await rejects(rpc(db, "wp_redeem_link_code", { p_link_code: link_code }), "wp_not_found");
});

test("leaving removes your log, and the last person out deletes the pact", async () => {
  const mars = await newPact();
  const sam = await join(mars.code);
  await log(sam, 250);
  await rpc(db, "wp_leave_pact", { p_member_id: sam.member_id, p_key: sam.member_key });
  const pact = await getPact(mars.code);
  assert.deepEqual(pact.members.map((m) => m.name), ["Mars"]);
  assert.equal(pact.entries.length, 0);
  await rejects(log(sam, 250), "wp_auth");
  await rpc(db, "wp_leave_pact", { p_member_id: mars.member_id, p_key: mars.member_key });
  await rejects(getPact(mars.code), "wp_not_found");
});

test("the public role cannot touch tables or helpers directly", async () => {
  await assert.rejects(db.query("select * from water_pact.pacts"), /permission denied/);
  await assert.rejects(db.query("select * from water_pact.member_keys"), /permission denied/);
  await assert.rejects(db.query("select water_pact.random_code(10)"), /permission denied/);
});

test("device keys are stored hashed", async () => {
  const mars = await newPact();
  const rows = await asOwner(db, "select key_hash from water_pact.member_keys where member_id = $1", [mars.member_id]);
  assert.equal(rows.rows.length, 1);
  assert.notEqual(rows.rows[0].key_hash, mars.member_key);
  assert.match(rows.rows[0].key_hash, /^[0-9a-f]{64}$/);
});

// ---------- abuse limits ----------

test("a day holds at most sixty drinks", async () => {
  const mars = await newPact();
  for (let i = 0; i < 60; i++) await log(mars, 10);
  await rejects(log(mars, 10), "wp_limit");
});

test("logging prunes that member's drinks older than the history window", async () => {
  const mars = await newPact();
  await asOwner(db,
    "insert into water_pact.drinks (id, member_id, ml, goal_ml, at, day) values (gen_random_uuid(), $1, 250, 2000, now() - interval '200 days', current_date - 200), (gen_random_uuid(), $1, 250, 2000, now() - interval '30 days', current_date - 30)",
    [mars.member_id]);
  await log(mars, 250);
  const rows = await asOwner(db, "select day from water_pact.drinks where member_id = $1 order by day", [mars.member_id]);
  assert.deepEqual(rows.rows.map((r) => new Date(r.day).toISOString().slice(0, 10)), [daysAgo(30), today()]);
});

test("starting a pact clears out long-abandoned ones", async () => {
  const stale = await newPact("Stale");
  const emptyOld = await newPact("Empty");
  const recentEmpty = await newPact("Recent");
  const quietButUsed = await newPact("Quiet");
  await log(quietButUsed, 250);
  await asOwner(db, "update water_pact.pacts set last_active = now() - interval '200 days' where code = $1", [stale.code]);
  await asOwner(db, "update water_pact.pacts set last_active = now() - interval '20 days' where code = any($1)", [[emptyOld.code, quietButUsed.code]]);

  await newPact("Trigger");

  await rejects(getPact(stale.code), "wp_not_found");
  await rejects(getPact(emptyOld.code), "wp_not_found");
  assert.equal((await getPact(recentEmpty.code)).members.length, 1, "a new pact with no drinks yet is kept");
  assert.equal((await getPact(quietButUsed.code)).members.length, 1, "a pact with drinks survives a quiet spell");
});

test("every write refreshes the pact's last-active time", async () => {
  const mars = await newPact();
  await asOwner(db, "update water_pact.pacts set last_active = now() - interval '50 days' where code = $1", [mars.code]);
  await log(mars, 250);
  const row = await asOwner(db, "select last_active > now() - interval '1 minute' as fresh from water_pact.pacts where code = $1", [mars.code]);
  assert.equal(row.rows[0].fresh, true);
});

test("oversized and invisible input is refused or stripped", async () => {
  await rejects(newPact("x".repeat(5000), 2000), "wp_invalid");
  const mars = await newPact("Ma\u200Brs\u202E");
  assert.equal((await getPact(mars.code)).members[0].name, "Mars");
  await rejects(newPact("\u200B\u200B", 2000), "wp_invalid");
  await rejects(join("Z".repeat(5000)), "wp_not_found");
  await rejects(log({ member_id: mars.member_id, member_key: "k".repeat(5000) }), "wp_auth");
});

test("reads go through POST only, so codes never land in a URL", async () => {
  const rows = await asOwner(db,
    "select proname, provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'wp\\_%'");
  assert.ok(rows.rows.length >= 11);
  assert.deepEqual(rows.rows.filter((r) => r.provolatile !== "v").map((r) => r.proname), []);
});

test("the schema can be applied again without losing data", async () => {
  const mars = await newPact();
  await log(mars, 250);
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  await asOwner(db, "select 1");
  await db.exec("reset role");
  try {
    await db.exec(sql);
  } finally {
    await db.exec("set role anon");
  }
  assert.equal((await getPact(mars.code)).entries.length, 1);
});
