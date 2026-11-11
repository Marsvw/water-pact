// App state: one immutable object, replaced on every change, with the parts
// worth keeping saved to this device.
import { LIMITS, ML_PER_OZ } from "./logic.js";

const STORAGE_KEY = "waterpact.v2";
const PERSISTED = ["identity", "unit", "bottleMl", "outbox", "pact", "installDismissed"];
const MAX_OUTBOX = 500;

const isText = (v) => typeof v === "string" && v.length > 0;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function defaultUnit() {
  const language = (globalThis.navigator && globalThis.navigator.language) || "";
  return language.toLowerCase() === "en-us" ? "oz" : "ml";
}

function cleanIdentity(raw) {
  if (!isObject(raw) || !isText(raw.code) || !isText(raw.memberId) || !isText(raw.key)) return null;
  return { code: raw.code, memberId: raw.memberId, key: raw.key };
}

function cleanOp(op) {
  if (!isObject(op) || !isText(op.opId) || !isText(op.id)) return null;
  if (op.type === "remove") return { opId: op.opId, type: "remove", id: op.id };
  const ok = op.type === "log" && Number.isFinite(op.ml) && Number.isFinite(op.goalMl) && isText(op.at) && isText(op.day);
  return ok ? { opId: op.opId, type: "log", id: op.id, ml: op.ml, goalMl: op.goalMl, at: op.at, day: op.day } : null;
}

function cleanPact(raw) {
  const ok = isObject(raw) && Number.isFinite(raw.rev) && isText(raw.since) && isText(raw.recentFrom)
    && Array.isArray(raw.members) && Array.isArray(raw.days) && Array.isArray(raw.entries);
  return ok ? raw : null;
}

/** Builds a valid state from whatever was saved on this device, however old or damaged. */
export function sanitizeSaved(raw) {
  const saved = isObject(raw) ? raw : {};
  const unit = saved.unit === "ml" || saved.unit === "oz" ? saved.unit : defaultUnit();
  const bottleOk = Number.isFinite(saved.bottleMl)
    && saved.bottleMl >= LIMITS.drinkMinMl && saved.bottleMl <= LIMITS.drinkMaxMl;
  const identity = cleanIdentity(saved.identity);
  return Object.freeze({
    identity,
    unit,
    bottleMl: bottleOk ? saved.bottleMl : (unit === "oz" ? Math.round(24 * ML_PER_OZ) : 750),
    outbox: identity && Array.isArray(saved.outbox) ? saved.outbox.map(cleanOp).filter(Boolean).slice(0, MAX_OUTBOX) : [],
    pact: identity ? cleanPact(saved.pact) : null,
    installDismissed: saved.installDismissed === true,
    online: true,    // false: no connection
    trouble: false,  // true: connected, but the server is not answering properly
    notice: null,
  });
}

export function loadSaved(storage = globalThis.localStorage) {
  try {
    return sanitizeSaved(JSON.parse(storage.getItem(STORAGE_KEY) || "null"));
  } catch {
    // Private mode or blocked storage: the app still works for this visit.
    return sanitizeSaved(null);
  }
}

/** Saves the lasting parts of the state. Returns false when the device refuses. */
export function persist(state, storage = globalThis.localStorage) {
  try {
    const subset = Object.fromEntries(PERSISTED.map((k) => [k, state[k]]));
    storage.setItem(STORAGE_KEY, JSON.stringify(subset));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} initial
 * @returns {{ get: () => object, set: (patch: object) => void, subscribe: (fn: (state: object, prev: object) => void) => () => void }}
 */
export function createStore(initial) {
  let state = Object.freeze({ ...initial });
  const listeners = new Set();
  return Object.freeze({
    get: () => state,
    set(patch) {
      const prev = state;
      state = Object.freeze({ ...state, ...patch });
      listeners.forEach((fn) => fn(state, prev));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
}

/** True when something worth saving differs between two states. */
export const persistedChanged = (a, b) => PERSISTED.some((k) => a[k] !== b[k]);
