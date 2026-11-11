import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ML_PER_OZ, LIMITS, toUnit, fromUnit, fmtNumber, fmtAmount, fmtInput, parseAmount, cleanName,
  LINK_CODE_LENGTH, normalizeCode, formatCode, parseJoinHash, zonedNow, shiftKey, keyToDate, calendarWeeks,
  paceFraction, expectedMl, paceStatus, streak, newId,
} from "../js/logic.js";

test("unit conversion round-trips", () => {
  assert.equal(toUnit(500, "ml"), 500);
  assert.equal(fromUnit(500, "ml"), 500);
  assert.ok(Math.abs(toUnit(ML_PER_OZ * 8, "oz") - 8) < 1e-9);
  assert.ok(Math.abs(fromUnit(8, "oz") - ML_PER_OZ * 8) < 1e-9);
});

test("amounts are formatted for reading", () => {
  assert.equal(fmtNumber(1250, "ml", "en-US"), "1,250");
  assert.equal(fmtAmount(1250, "ml", "en-US"), "1,250 ml");
  assert.equal(fmtAmount(64 * ML_PER_OZ, "oz", "en-US"), "64 oz");
  assert.equal(fmtAmount(5.5 * ML_PER_OZ, "oz", "en-US"), "5.5 oz");
});

test("input values use plain digits whatever the locale", () => {
  assert.equal(fmtInput(2000, "ml"), "2000");
  assert.equal(fmtInput(64 * ML_PER_OZ, "oz"), "64");
  assert.equal(fmtInput(16.9 * ML_PER_OZ, "oz"), "16.9");
});

test("typed amounts are parsed and range-checked", () => {
  const { drinkMinMl: min, drinkMaxMl: max } = LIMITS;
  assert.deepEqual(parseAmount("330", "ml", min, max), { ok: true, ml: 330 });
  assert.deepEqual(parseAmount(" 0,5 ", "ml", 0, max), { ok: true, ml: 1 });
  assert.deepEqual(parseAmount("12", "oz", min, max), { ok: true, ml: Math.round(12 * ML_PER_OZ) });
  assert.deepEqual(parseAmount("", "ml", min, max), { ok: false, reason: "empty" });
  assert.deepEqual(parseAmount("abc", "ml", min, max), { ok: false, reason: "empty" });
  assert.deepEqual(parseAmount("5", "ml", min, max), { ok: false, reason: "range" });
  assert.deepEqual(parseAmount("99999", "ml", min, max), { ok: false, reason: "range" });
});

test("names are trimmed, collapsed and capped", () => {
  assert.equal(cleanName("  Mars   W  "), "Mars W");
  assert.equal(cleanName("x".repeat(40)).length, LIMITS.nameMax);
  assert.equal(cleanName(null), "");
});

test("invite codes are normalized and validated", () => {
  assert.equal(normalizeCode("abcde-fghjk"), "ABCDEFGHJK");
  assert.equal(normalizeCode(" ABCDE FGHJK "), "ABCDEFGHJK");
  assert.equal(normalizeCode("ABCDE"), null);
  assert.equal(normalizeCode("ABCDEFGHI1"), null, "I and 1 are not in the alphabet");
  assert.equal(normalizeCode("ABCDEFGH", 8), "ABCDEFGH");
  assert.equal(formatCode("ABCDEFGHJK"), "ABCDE-FGHJK");
  assert.equal(formatCode("ABCDEFGH"), "ABCD-EFGH");
});

test("a mangled invite link is ignored instead of crashing the app", () => {
  assert.equal(parseJoinHash("#join=ABC%E0%A4%A"), null);
  assert.equal(parseJoinHash("#join=%"), null);
  assert.equal(parseJoinHash("#join=ABCDE%2DFGHJK"), "ABCDEFGHJK");
});

test("invisible characters cannot hide inside a name", () => {
  assert.equal(cleanName("Ma\u200Brs\u202E"), "Mars");
  assert.equal(cleanName("\u200B\u200B"), "");
  assert.equal(cleanName("Mars\tvan\nWater"), "Mars van Water");
});

test("link codes are as long as invite codes", () => {
  assert.equal(LINK_CODE_LENGTH, 10);
  assert.equal(normalizeCode("abcde-fghjk", LINK_CODE_LENGTH), "ABCDEFGHJK");
});

test("the join hash carries an invite code", () => {
  assert.equal(parseJoinHash("#join=ABCDE-FGHJK"), "ABCDEFGHJK");
  assert.equal(parseJoinHash("#join=abcdefghjk"), "ABCDEFGHJK");
  assert.equal(parseJoinHash("#join=short"), null);
  assert.equal(parseJoinHash("#other"), null);
  assert.equal(parseJoinHash(""), null);
});

test("zonedNow reports the local day and hour in a time zone", () => {
  const instant = new Date("2026-11-11T02:30:00Z");
  assert.deepEqual(zonedNow(instant, "UTC"), { key: "2026-11-11", hours: 2.5 });
  assert.deepEqual(zonedNow(instant, "America/New_York"), { key: "2026-11-10", hours: 21.5 });
  assert.deepEqual(zonedNow(instant, "Asia/Tokyo"), { key: "2026-11-11", hours: 11.5 });
});

test("zonedNow falls back to the device zone for junk zones", () => {
  const instant = new Date("2026-11-11T12:00:00Z");
  assert.deepEqual(zonedNow(instant, "Not/AZone"), zonedNow(instant));
});

test("date keys shift across month and year ends", () => {
  assert.equal(shiftKey("2026-11-11", -11), "2026-10-31");
  assert.equal(shiftKey("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftKey("2026-03-01", -1), "2026-02-28");
  assert.equal(keyToDate("2026-11-11").getDate(), 11);
});

test("calendar weeks run Monday to Sunday and end with the current week", () => {
  const weeks = calendarWeeks("2026-11-11", 4); // a Wednesday
  assert.equal(weeks.length, 4);
  assert.deepEqual(weeks[3], ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
  assert.equal(weeks[0][0], "2026-10-19");
  assert.deepEqual(calendarWeeks("2026-11-15", 1)[0][6], "2026-11-15", "Sunday closes its own week");
});

test("pace runs from 8am to 10pm", () => {
  assert.equal(paceFraction(6), 0);
  assert.equal(paceFraction(8), 0);
  assert.equal(paceFraction(15), 0.5);
  assert.equal(paceFraction(22), 1);
  assert.equal(paceFraction(23.5), 1);
  assert.equal(expectedMl(2000, 15), 1000);
});

test("pace status says done, on pace, behind or not started", () => {
  assert.deepEqual(paceStatus(2000, 2000, 10), { kind: "done", behindMl: 0 });
  assert.deepEqual(paceStatus(0, 2000, 7), { kind: "idle", behindMl: 0 });
  assert.deepEqual(paceStatus(1000, 2000, 15), { kind: "pace", behindMl: 0 });
  assert.deepEqual(paceStatus(950, 2000, 15), { kind: "pace", behindMl: 0 }, "5% slack");
  assert.deepEqual(paceStatus(500, 2000, 15), { kind: "behind", behindMl: 500 });
  assert.deepEqual(paceStatus(0, 2000, 23), { kind: "behind", behindMl: 2000 });
});

test("a streak counts met days ending today, or yesterday if today is still open", () => {
  const met = new Set(["2026-11-11", "2026-11-10", "2026-11-09", "2026-11-07"]);
  assert.equal(streak((k) => met.has(k), "2026-11-11", 70), 3);
  assert.equal(streak((k) => met.has(k), "2026-11-12", 70), 3, "today not met yet keeps the run alive");
  assert.equal(streak((k) => met.has(k), "2026-11-13", 70), 0, "a missed day breaks it");
  assert.equal(streak(() => true, "2026-11-11", 10), 10, "capped by the history window");
  assert.equal(streak(() => false, "2026-11-11", 70), 0);
});

test("new ids are unique uuids", () => {
  const a = newId(), b = newId();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});
