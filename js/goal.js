// Suggests a daily goal from body weight and weekly exercise. Pure, so it is easy to test.
//
// A common rule of thumb: about 35 ml of drinks per kg of body weight, plus roughly a litre
// for every hour of exercise (a middling sweat rate), spread across the week because the
// app has one goal for every day. It is a starting point, not medical advice.
import { LIMITS } from "./logic.js";

export const ML_PER_KG = 35;
export const ML_PER_EXERCISE_HOUR = 1000;
export const KG_PER_LB = 0.45359237;
export const GOAL_STEP_ML = 50;
export const BODY_LIMITS = Object.freeze({ weightMinKg: 30, weightMaxKg: 250, exerciseMaxHours: 40 });

const DAYS_PER_WEEK = 7;

/** Weight goes with the drink unit: kg beside ml, lb beside oz. */
export const weightUnitFor = (amountUnit) => (amountUnit === "oz" ? "lb" : "kg");

const toKg = (value, weightUnit) => (weightUnit === "lb" ? value * KG_PER_LB : value);
const fromKg = (kg, weightUnit) => (weightUnit === "lb" ? kg / KG_PER_LB : kg);

function readNumber(raw) {
  const text = String(raw ?? "").trim().replace(",", ".");
  return { text, value: Number(text) };
}

/** @returns {{ ok: true, kg: number } | { ok: false, reason: "empty" | "range" }} */
export function parseWeight(raw, weightUnit) {
  const { text, value } = readNumber(raw);
  if (!text || !Number.isFinite(value)) return { ok: false, reason: "empty" };
  const kg = toKg(value, weightUnit);
  if (kg < BODY_LIMITS.weightMinKg || kg > BODY_LIMITS.weightMaxKg) return { ok: false, reason: "range" };
  return { ok: true, kg };
}

/** Hours of exercise a week. Leaving it blank means none. */
export function parseExercise(raw) {
  const { text, value } = readNumber(raw);
  if (!text) return { ok: true, hours: 0 };
  if (!Number.isFinite(value) || value < 0 || value > BODY_LIMITS.exerciseMaxHours) return { ok: false, reason: "range" };
  return { ok: true, hours: value };
}

/**
 * @param {{ weightKg: number, exerciseHours: number }} body
 * @returns {number} a daily goal in ml, rounded to 50 ml and inside the app's goal limits
 */
export function suggestGoal({ weightKg, exerciseHours }) {
  const ml = weightKg * ML_PER_KG + (exerciseHours * ML_PER_EXERCISE_HOUR) / DAYS_PER_WEEK;
  const rounded = Math.round(ml / GOAL_STEP_ML) * GOAL_STEP_ML;
  return Math.min(LIMITS.goalMaxMl, Math.max(LIMITS.goalMinMl, rounded));
}

/** Plain digits for <input type="number">, to one decimal place. */
export const fmtWeightInput = (kg, weightUnit) => String(Math.round(fromKg(kg, weightUnit) * 10) / 10);

/** Re-expresses a typed weight in another unit; anything unreadable is left as typed. */
export function switchWeightUnit(raw, from, to) {
  if (from === to) return raw;
  const { text, value } = readNumber(raw);
  if (!text || !Number.isFinite(value)) return raw;
  return fmtWeightInput(toKg(value, from), to);
}
