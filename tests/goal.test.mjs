import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "../js/logic.js";
import {
  BODY_LIMITS, KG_PER_LB, fmtWeightInput, parseExercise, parseWeight, suggestGoal, switchWeightUnit, weightUnitFor,
} from "../js/goal.js";

test("weight is shown in kg next to ml and in lb next to oz", () => {
  assert.equal(weightUnitFor("ml"), "kg");
  assert.equal(weightUnitFor("oz"), "lb");
});

test("an 80 kg person who does no exercise gets 2,800 ml", () => {
  assert.equal(suggestGoal({ weightKg: 80, exerciseHours: 0 }), 2800);
});

test("a 60 kg runner doing two hours a week gets 2,400 ml", () => {
  // 2,100 ml for her weight plus 2 litres a week spread over 7 days (286 ml), rounded to 50 ml.
  assert.equal(suggestGoal({ weightKg: 60, exerciseHours: 2 }), 2400);
});

test("suggestions are rounded to the nearest 50 ml", () => {
  assert.equal(suggestGoal({ weightKg: 71, exerciseHours: 0 }), 2500); // 2,485 ml
  assert.equal(suggestGoal({ weightKg: 70.5, exerciseHours: 0 }), 2450); // 2,467.5 ml
});

test("suggestions stay inside the goals the app accepts", () => {
  const top = suggestGoal({ weightKg: BODY_LIMITS.weightMaxKg, exerciseHours: BODY_LIMITS.exerciseMaxHours });
  assert.equal(top, LIMITS.goalMaxMl);
  const bottom = suggestGoal({ weightKg: BODY_LIMITS.weightMinKg, exerciseHours: 0 });
  assert.ok(bottom >= LIMITS.goalMinMl);
});

test("weights are parsed in kg or lb, with a comma or a point", () => {
  assert.deepEqual(parseWeight("60", "kg"), { ok: true, kg: 60 });
  assert.deepEqual(parseWeight(" 60,5 ", "kg"), { ok: true, kg: 60.5 });
  const lb = parseWeight("176.4", "lb");
  assert.equal(lb.ok, true);
  assert.ok(Math.abs(lb.kg - 176.4 * KG_PER_LB) < 1e-9);
});

test("weights that are missing or implausible are refused", () => {
  assert.deepEqual(parseWeight("", "kg"), { ok: false, reason: "empty" });
  assert.deepEqual(parseWeight("abc", "kg"), { ok: false, reason: "empty" });
  assert.deepEqual(parseWeight(String(BODY_LIMITS.weightMinKg - 1), "kg"), { ok: false, reason: "range" });
  assert.deepEqual(parseWeight(String(BODY_LIMITS.weightMaxKg + 1), "kg"), { ok: false, reason: "range" });
  assert.deepEqual(parseWeight("20", "lb"), { ok: false, reason: "range" });
});

test("exercise is optional and counted in hours a week", () => {
  assert.deepEqual(parseExercise(""), { ok: true, hours: 0 });
  assert.deepEqual(parseExercise("  "), { ok: true, hours: 0 });
  assert.deepEqual(parseExercise("2"), { ok: true, hours: 2 });
  assert.deepEqual(parseExercise("1,5"), { ok: true, hours: 1.5 });
});

test("exercise hours that make no sense are refused", () => {
  assert.deepEqual(parseExercise("-1"), { ok: false, reason: "range" });
  assert.deepEqual(parseExercise(String(BODY_LIMITS.exerciseMaxHours + 1)), { ok: false, reason: "range" });
  assert.deepEqual(parseExercise("lots"), { ok: false, reason: "range" });
});

test("weights are written back as plain digits", () => {
  assert.equal(fmtWeightInput(60, "kg"), "60");
  assert.equal(fmtWeightInput(60.25, "kg"), "60.3");
  assert.equal(fmtWeightInput(80, "lb"), "176.4");
});

test("switching units converts a typed weight and leaves anything else alone", () => {
  assert.equal(switchWeightUnit("80", "kg", "lb"), "176.4");
  assert.equal(switchWeightUnit("176.4", "lb", "kg"), "80");
  assert.equal(switchWeightUnit("80", "kg", "kg"), "80");
  assert.equal(switchWeightUnit("", "kg", "lb"), "");
  assert.equal(switchWeightUnit("abc", "kg", "lb"), "abc");
});
