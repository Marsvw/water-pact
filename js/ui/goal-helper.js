// "Work out my goal": a fold-out panel that suggests a daily goal from weight and exercise.
// What is typed here is used for the sum only; it is never saved or sent anywhere.
import { fmtAmount } from "../logic.js";
import {
  BODY_LIMITS, KG_PER_LB, parseExercise, parseWeight, suggestGoal, switchWeightUnit, weightUnitFor,
} from "../goal.js";
import { field, h } from "./dom.js";

let helperCount = 0;
// Typing "72" passes through "7" first; waiting for a pause keeps screen readers from
// announcing every in-between answer.
const RESULT_DELAY_MS = 300;

function weightRangeText(weightUnit) {
  const toUnit = (kg) => (weightUnit === "lb" ? kg / KG_PER_LB : kg);
  // Rounded inwards, so every whole number in the message is one the panel accepts.
  const min = Math.ceil(toUnit(BODY_LIMITS.weightMinKg));
  const max = Math.floor(toUnit(BODY_LIMITS.weightMaxKg));
  return `Enter a weight between ${min} and ${max} ${weightUnit}.`;
}

function resultText({ weight, exercise, goalMl, unit }) {
  if (goalMl !== null) return `Suggested goal: ${fmtAmount(goalMl, unit)} a day.`;
  if (!exercise.ok) return `Enter exercise between 0 and ${BODY_LIMITS.exerciseMaxHours} hours a week.`;
  if (weight.reason === "range") return weightRangeText(weightUnitFor(unit));
  return "Enter your weight to see a suggestion.";
}

/**
 * @param {{ unit: string, onUse: (goalMl: number) => void }} options
 *   unit: the drink unit, ml or oz. onUse fills in the goal field and should move focus
 *   to it, because the panel closes and focus would otherwise be lost.
 * @returns {{ root: HTMLDetailsElement, switchUnit: (from: string, to: string) => void }}
 */
export function goalHelper({ unit: initialUnit, onUse }) {
  const id = `goal-help-${++helperCount}`;
  let unit = initialUnit;
  let goalMl = null;
  let resultTimer = 0;

  const weight = field({ id: `${id}-weight`, label: "Your weight", type: "number", inputmode: "decimal", step: "any", suffix: weightUnitFor(unit) });
  const exercise = field({ id: `${id}-exercise`, label: "Exercise a week", type: "number", inputmode: "decimal", step: "any", suffix: "hours", placeholder: "0" });
  const result = h("p", { class: "goal-help-result", role: "status", text: "Enter your weight to see a suggestion." });
  const useButton = h("button", { type: "button", class: "ghost-btn", text: "Use this goal", disabled: true });

  function refresh() {
    const parsedWeight = parseWeight(weight.input.value, weightUnitFor(unit));
    const parsedExercise = parseExercise(exercise.input.value);
    goalMl = parsedWeight.ok && parsedExercise.ok
      ? suggestGoal({ weightKg: parsedWeight.kg, exerciseHours: parsedExercise.hours })
      : null;
    useButton.disabled = goalMl === null;
    const text = resultText({ weight: parsedWeight, exercise: parsedExercise, goalMl, unit });
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => {
      if (result.textContent !== text) result.textContent = text;
    }, RESULT_DELAY_MS);
  }

  const root = h("details", { class: "goal-help" },
    h("summary", { text: "Work out my goal" }),
    h("div", { class: "goal-help-body" },
      h("div", { class: "row" }, weight.wrap, exercise.wrap),
      h("p", { class: "hint", text: "About 35 ml per kg of body weight, plus roughly a litre for every hour of exercise, spread over the week. Running 10 km takes most people about an hour. Your weight isn't saved or sent anywhere." }),
      result,
      useButton));

  function use() {
    if (goalMl === null) return;
    onUse(goalMl);
    root.open = false;
  }

  [weight.input, exercise.input].forEach((input) => {
    input.addEventListener("input", refresh);
    // Enter here means "use this", not "submit the whole form".
    input.addEventListener("keydown", (evt) => {
      if (evt.key !== "Enter") return;
      evt.preventDefault();
      use();
    });
  });
  useButton.addEventListener("click", use);

  return Object.freeze({
    root,
    switchUnit(from, to) {
      unit = to;
      weight.input.value = switchWeightUnit(weight.input.value, weightUnitFor(from), weightUnitFor(to));
      weight.suffix.textContent = weightUnitFor(to);
      refresh();
    },
  });
}
