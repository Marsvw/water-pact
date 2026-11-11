// Pure helpers: units, parsing, dates and pace. No DOM, no network, no storage.

export const ML_PER_OZ = 29.5735;
export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 22;
export const HISTORY_DAYS = 70;
export const RECENT_DAYS = 2;
export const CODE_LENGTH = 10;
export const LINK_CODE_LENGTH = 10;
// No I, L, O, 0 or 1: the same alphabet the database draws codes from.
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const LIMITS = Object.freeze({
  goalMinMl: 500,
  goalMaxMl: 8000,
  drinkMinMl: 10,
  drinkMaxMl: 3000,
  nameMax: 24,
});

// Control and zero-width/direction characters, which could make one name pass for another.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const PACE_SLACK = 0.05;
const BEHIND_STEP_ML = 50;
const pad2 = (n) => String(n).padStart(2, "0");
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- units ----------

export const toUnit = (ml, unit) => (unit === "oz" ? ml / ML_PER_OZ : ml);
export const fromUnit = (value, unit) => (unit === "oz" ? value * ML_PER_OZ : value);

export function fmtNumber(ml, unit, locale) {
  const v = toUnit(ml, unit);
  if (unit === "oz") {
    const rounded = v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
    return rounded.toLocaleString(locale);
  }
  return Math.round(v).toLocaleString(locale);
}

export const fmtAmount = (ml, unit, locale) => `${fmtNumber(ml, unit, locale)} ${unit}`;

/** Plain digits for <input type="number">, which rejects locale separators. */
export function fmtInput(ml, unit) {
  const v = toUnit(ml, unit);
  return String(unit === "oz" ? Math.round(v * 10) / 10 : Math.round(v));
}

/** Parses what someone typed into an amount field. Accepts a comma as the decimal mark. */
export function parseAmount(raw, unit, minMl, maxMl) {
  const text = String(raw ?? "").trim().replace(",", ".");
  const value = Number(text);
  if (!text || !Number.isFinite(value)) return { ok: false, reason: "empty" };
  const ml = fromUnit(value, unit);
  if (ml < minMl || ml > maxMl) return { ok: false, reason: "range" };
  return { ok: true, ml: Math.round(ml) };
}

export function cleanName(raw) {
  return String(raw ?? "").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().slice(0, LIMITS.nameMax);
}

// ---------- codes ----------

export function normalizeCode(raw, length = CODE_LENGTH) {
  const code = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== length) return null;
  return [...code].every((ch) => CODE_ALPHABET.includes(ch)) ? code : null;
}

export function formatCode(code) {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

export function parseJoinHash(hash) {
  const match = /^#join=(.+)$/.exec(String(hash ?? ""));
  if (!match) return null;
  try {
    return normalizeCode(decodeURIComponent(match[1]));
  } catch {
    // A link mangled in transit must not stop the app from opening.
    return null;
  }
}

// ---------- dates ----------

function zonedParts(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

/** The calendar day and the hour of day at `date` in a time zone (the device's when omitted or invalid). */
export function zonedNow(date, tz) {
  let parts;
  try {
    parts = zonedParts(date, tz || undefined);
  } catch {
    parts = zonedParts(date, undefined);
  }
  return {
    key: `${parts.year}-${parts.month}-${parts.day}`,
    hours: Number(parts.hour) + Number(parts.minute) / 60,
  };
}

export function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const keyToUtc = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const utcToKey = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};

export const shiftKey = (key, days) => utcToKey(keyToUtc(key) + days * 86400000);

/** A local Date for a day key, for showing weekday names and day numbers. */
export function keyToDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** `count` Monday-to-Sunday weeks of day keys, the last one containing `todayKey`. */
export function calendarWeeks(todayKey, count) {
  const weekday = new Date(keyToUtc(todayKey)).getUTCDay(); // 0 = Sunday
  const monday = shiftKey(todayKey, -((weekday + 6) % 7));
  return Array.from({ length: count }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => shiftKey(monday, (w - (count - 1)) * 7 + d)));
}

// ---------- pace ----------

/** How much of the drinking day (8am to 10pm) has passed, from 0 to 1. */
export const paceFraction = (hours) =>
  clamp((hours - DAY_START_HOUR) / (DAY_END_HOUR - DAY_START_HOUR), 0, 1);

export const expectedMl = (goalMl, hours) => goalMl * paceFraction(hours);

export function paceStatus(totalMl, goalMl, hours) {
  if (totalMl >= goalMl) return { kind: "done", behindMl: 0 };
  const expected = expectedMl(goalMl, hours);
  if (totalMl === 0 && expected === 0) return { kind: "idle", behindMl: 0 };
  if (totalMl >= expected - goalMl * PACE_SLACK) return { kind: "pace", behindMl: 0 };
  return { kind: "behind", behindMl: Math.ceil((expected - totalMl) / BEHIND_STEP_ML) * BEHIND_STEP_ML };
}

/** Days in a row the goal was met, ending today, or yesterday while today is still open. */
export function streak(isMet, todayKey, maxDays) {
  const start = isMet(todayKey) ? 0 : 1;
  let count = 0;
  for (let i = start; i < start + maxDays; i++) {
    if (!isMet(shiftKey(todayKey, -i))) break;
    count++;
  }
  return Math.min(count, maxDays);
}

// ---------- ids ----------

export function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Older phones: build a version 4 UUID from random bytes.
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
