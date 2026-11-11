// Small DOM helpers shared by every screen.
import { fmtInput, parseAmount } from "../logic.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const TOAST_MS = 2800;

/**
 * Builds an element. Props: `class`, `text`, `on<Event>` handlers, `dataset`,
 * DOM properties (value, disabled, hidden…) and anything else as an attribute.
 * Text only ever goes in through textContent, never as markup.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && !key.startsWith("aria") && key !== "list" && key !== "form") el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

export function svg(tag, attrs = {}, children = []) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  el.append(...children);
  return el;
}

export function detectPlatform(nav = navigator, win = window) {
  const ua = nav.userAgent || "";
  const isAndroid = /Android/i.test(ua);
  // iPads report themselves as Macs; a touch screen gives them away.
  const isIOS = !isAndroid && (/iPad|iPhone|iPod/.test(ua) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1));
  const isStandalone = win.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
  return Object.freeze({ isIOS, isAndroid, isMobile: isIOS || isAndroid, isStandalone });
}

/**
 * Opens a bottom sheet and returns the function that closes it. The sheet is removed
 * as soon as it closes, whether by that function or by Escape or the back gesture;
 * the browser's own "close" event can arrive late when the app is in the background.
 */
export function openSheet(dialog) {
  const dismiss = () => {
    if (dialog.open) dialog.close();
    dialog.remove();
  };
  dialog.addEventListener("close", dismiss);
  document.body.append(dialog);
  dialog.showModal();
  return dismiss;
}

/** Closes every open sheet, for when the screen underneath goes away. */
export function closeSheets() {
  document.querySelectorAll("dialog.sheet").forEach((dialog) => {
    if (dialog.open) dialog.close();
    dialog.remove();
  });
}

let toastTimer = 0;
export function toast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  // Shown as a popover where supported, so it sits above an open settings sheet.
  const layered = typeof el.showPopover === "function";
  el.textContent = message;
  el.hidden = false;
  if (layered) {
    if (el.matches(":popover-open")) el.hidePopover();
    el.showPopover();
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (layered && el.matches(":popover-open")) el.hidePopover();
    el.hidden = true;
  }, TOAST_MS);
}

/**
 * Hands a link to the phone's share sheet, or copies it where there is none.
 * @returns {Promise<"shared" | "copied" | "cancelled" | "failed">}
 */
export async function shareLink({ title, text, url }) {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title, text, url });
      return "shared";
    } catch (e) {
      if (e && e.name === "AbortError") return "cancelled";
      // Fall through to copying.
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}

// What each amount field was last filled with, so a unit switch converts the
// exact value instead of the rounded one on screen.
const amountMemory = new WeakMap();

export function setAmount(input, ml, unit) {
  const shown = fmtInput(ml, unit);
  input.value = shown;
  amountMemory.set(input, { ml, shown, unit });
}

/**
 * Reads an amount field. An untouched field gives back the exact amount it was
 * filled with, so 2000 ml shown as 67.6 oz saves as 2000 ml, not 1999.
 */
export function readAmount(input, unit, minMl, maxMl) {
  const memory = amountMemory.get(input);
  if (memory && memory.shown === input.value && memory.unit === unit) {
    const ml = Math.round(memory.ml);
    return ml >= minMl && ml <= maxMl ? { ok: true, ml } : { ok: false, reason: "range" };
  }
  return parseAmount(input.value, unit, minMl, maxMl);
}

export function switchAmountUnit(input, from, to) {
  const memory = amountMemory.get(input);
  if (memory && memory.shown === input.value) {
    setAmount(input, memory.ml, to);
    return;
  }
  const typed = parseAmount(input.value, from, 0, Infinity);
  if (typed.ok) setAmount(input, typed.ml, to);
}

export const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** A labelled input with an optional unit suffix. Returns the wrapper and the input. */
export function field({ id, label, type = "text", suffix = null, ...inputProps }) {
  const input = h("input", { id, type, ...inputProps });
  const wrap = h("div", { class: "field" },
    h("label", { for: id, text: label }),
    h("div", { class: "input-wrap" }, input, suffix && h("span", { class: "suffix", text: suffix })));
  return { wrap, input, suffix: wrap.querySelector(".suffix") };
}
