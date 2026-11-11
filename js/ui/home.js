// The main screen: both glasses, the pour panel, the shared log and history.
import {
  LIMITS, ML_PER_OZ, deviceTimeZone, fmtAmount, fmtNumber, formatCode, parseAmount,
} from "../logic.js";
import { buildModel, statusLabel, summaryText } from "../model.js";
import { closeSheets, field, fmtTime, h, openSheet, shareLink, svg, toast } from "./dom.js";
import { renderFeed, renderHistory } from "./history.js";
import { installSteps } from "./install.js";
import { openSettings } from "./settings.js";
import { createVessel, glassIcon } from "./vessel.js";

const NUDGE_TTL_MS = 18 * 3600 * 1000;
const CLOCK_MS = 60 * 1000;
const CELEBRATE_MS = 1800;
const RENDER_FALLBACK_MS = 250;
const DEFAULT_GOAL_ML = 2000;

function settingsIcon() {
  // Three sliders: reads as "adjust" at a glance.
  return svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, [
    svg("path", { d: "M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" }),
    svg("circle", { cx: 15, cy: 7, r: 2 }),
    svg("circle", { cx: 9, cy: 12, r: 2 }),
    svg("circle", { cx: 17, cy: 17, r: 2 }),
  ]);
}

/**
 * @param {HTMLElement} root
 * @param {{ api: object, store: object, sync: object, platform: object, inviteUrl: (code: string) => string, installPrompt: () => any }} ctx
 */
export function createHome(root, ctx) {
  const { store, sync, platform } = ctx;
  const cards = new Map();      // member id or placeholder key -> card parts
  const metBefore = new Map();  // member id -> whether their goal was met at the last draw
  let presetKey = "";
  let feedKey = "";
  let historyKey = "";
  let queued = false;
  let destroyed = false;

  // ----- skeleton (built once, then updated in place) -----
  const dateLabel = h("p", { class: "eyebrow" });
  const summary = h("p", { class: "summary" });
  const syncNote = h("p", { class: "sync-note", role: "status", hidden: true });
  const nudgeText = h("p");
  const nudgeBanner = h("div", { class: "banner", hidden: true }, nudgeText,
    h("button", { type: "button", text: "Got it", onClick: () => sync.clearNudge() }));
  const tanks = h("section", { class: "tanks", "aria-label": "Today's progress" });
  const quick = h("div", { class: "quick" });
  const undoBtn = h("button", { type: "button", class: "text-btn", text: "Undo last", disabled: true, onClick: undoLast });
  const custom = field({ id: "custom-amount", label: "Another amount", type: "number", inputmode: "decimal", step: "any", suffix: "ml" });
  const customError = h("p", { class: "error", role: "alert", hidden: true });
  const customForm = h("form", { class: "field-form", novalidate: true, onSubmit: submitCustom },
    h("div", { class: "row" }, custom.wrap, h("button", { type: "submit", class: "solid-btn", text: "Add" })),
    customError);

  const inviteCode = h("strong", { class: "code" });
  const inviteLink = h("input", { class: "link-out", type: "text", readOnly: true, hidden: true, "aria-label": "Invite link" });
  const inviteCard = h("section", { class: "card", hidden: true, "aria-labelledby": "invite-title" },
    h("h2", { id: "invite-title", text: "Invite your friend" }),
    h("p", { text: "Send them this link. They install the app, pick a goal, and their glass shows up next to yours." }),
    h("div", { class: "code-box" }, h("span", { class: "code-label", text: "Invite code" }), inviteCode),
    h("button", { type: "button", class: "solid-btn", text: "Share invite link", onClick: shareInvite }),
    inviteLink);

  const installCard = h("section", { class: "card is-quiet", hidden: true, "aria-labelledby": "install-title" },
    h("h2", { id: "install-title", text: "Put it on your home screen" }),
    h("p", { text: "Water Pact works best installed: one tap to open, full screen, its own icon." }),
    h("button", { type: "button", class: "ghost-btn", text: "Show me how", onClick: openInstallDialog }));

  const feedList = h("ol", { class: "feed" });
  const feedEmpty = h("p", { class: "feed-empty", text: "No drinks logged yet today. Tap a glass above to log your first one." });
  const history = h("div", { class: "history" });

  root.replaceChildren(h("main", { class: "home" },
    h("header", { class: "top" },
      h("div", {}, dateLabel, h("h1", { text: "Water Pact" })),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Settings", onClick: () => openSettings(ctx) }, settingsIcon())),
    summary,
    syncNote,
    nudgeBanner,
    tanks,
    h("p", { class: "hint legend", text: "Dashed line: the goal. Arrow: where you should be by now." }),
    h("section", { class: "panel", "aria-labelledby": "pour-title" },
      h("div", { class: "panel-head" }, h("h2", { id: "pour-title", text: "Log a drink" }), undoBtn),
      quick,
      customForm),
    inviteCard,
    installCard,
    h("section", { class: "panel", "aria-labelledby": "feed-title" },
      h("h2", { id: "feed-title", text: "Today's log" }), feedList, feedEmpty),
    h("section", { class: "panel", "aria-labelledby": "history-title" },
      h("h2", { id: "history-title", text: "Last 4 weeks" }), history)));

  // ----- actions -----
  function currentModel() {
    const state = store.get();
    return buildModel({
      pact: state.pact, outbox: state.outbox, memberId: state.identity ? state.identity.memberId : null,
      now: new Date(), deviceTz: deviceTimeZone(),
    });
  }

  function addDrink(ml) {
    if (sync.logDrink(ml)) toast(`Logged ${fmtAmount(ml, store.get().unit)}`);
  }

  function undoLast() {
    const { identity } = store.get();
    const last = currentModel().feed.find((f) => f.memberId === identity.memberId);
    if (!last) return;
    sync.removeDrink(last.id);
    toast("Removed your last drink");
  }

  function submitCustom(evt) {
    evt.preventDefault();
    const { unit } = store.get();
    const parsed = parseAmount(custom.input.value, unit, LIMITS.drinkMinMl, LIMITS.drinkMaxMl);
    if (!parsed.ok) {
      customError.textContent = `Enter an amount between ${fmtNumber(LIMITS.drinkMinMl, unit)} and ${fmtNumber(LIMITS.drinkMaxMl, unit)} ${unit}.`;
      customError.hidden = false;
      return;
    }
    customError.hidden = true;
    custom.input.value = "";
    addDrink(parsed.ml);
  }

  async function shareInvite() {
    const { identity } = store.get();
    const url = ctx.inviteUrl(identity.code);
    const result = await shareLink({
      title: "Water Pact",
      text: "Join my Water Pact so we both drink enough water.",
      url,
    });
    if (result === "copied") toast("Invite link copied");
    if (result === "failed") {
      inviteLink.value = url;
      inviteLink.hidden = false;
      inviteLink.select();
      toast("Copy the link below and send it");
    }
  }

  function openInstallDialog() {
    const note = platform.isIOS
      ? "In the new app, tap “Link this device” and enter a link code from Settings here."
      : "";
    let dismiss = () => {};
    const dialog = h("dialog", { class: "sheet", "aria-labelledby": "install-dialog-title" },
      h("div", { class: "sheet-head" },
        h("h2", { id: "install-dialog-title", text: "Install Water Pact" }),
        h("button", { type: "button", class: "text-btn", text: "Close", onClick: () => dismiss() })),
      installSteps({ platform, installPrompt: ctx.installPrompt, afterInstallNote: note }));
    dismiss = openSheet(dialog);
  }

  // ----- drawing -----
  function createCard() {
    const vessel = createVessel();
    const parts = {
      vessel,
      name: h("h3", { class: "tank-name" }),
      pill: h("span", { class: "pill" }),
      num: h("span", { class: "num" }),
      unit: h("span", { class: "unit" }),
      of: h("p", { class: "of" }),
      last: h("p", { class: "last" }),
      empty: h("p", { class: "empty-text", hidden: true }),
      actions: h("div", { class: "tank-actions" }),
      actionKey: "",
    };
    parts.reading = h("p", { class: "reading" }, parts.num, parts.unit);
    parts.el = h("article", { class: "tank" },
      parts.name, parts.pill, h("div", { class: "vessel-wrap" }, vessel.root),
      parts.reading, parts.of, parts.last, parts.empty, parts.actions);
    return parts;
  }

  function setActions(card, key, build) {
    if (card.actionKey === key) return;
    card.actionKey = key;
    card.actions.replaceChildren(...build());
  }

  function paintPerson(card, person, me, unit) {
    card.el.classList.toggle("is-me", person.isMe);
    card.el.classList.remove("is-empty");
    card.name.textContent = person.isMe ? "You" : person.name;
    card.pill.dataset.kind = person.status.kind;
    card.pill.textContent = statusLabel(person.status, unit);
    card.num.textContent = fmtNumber(person.totalMl, unit);
    card.unit.textContent = unit;
    card.of.textContent = `of ${fmtAmount(person.goalMl, unit)}`;
    card.last.textContent = person.lastAt ? `Last drink ${fmtTime(person.lastAt)}` : "No drinks yet today";
    [card.reading, card.of, card.last].forEach((el) => { el.hidden = false; });
    card.empty.hidden = true;
    card.vessel.paint({
      totalMl: person.totalMl, goalMl: person.goalMl, expectedMl: person.expectedMl,
      showPace: person.status.kind !== "done", unit,
    });

    if (person.isMe) {
      setActions(card, "none", () => []);
      return;
    }
    const nudgedByMe = Boolean(me && person.nudgedBy === me.id && person.nudgedAt);
    const key = person.status.kind === "done" ? "none" : nudgedByMe ? `nudged-${person.nudgedAt}` : "nudge";
    setActions(card, key, () => {
      if (key === "none") return [];
      return [h("button", {
        type: "button", class: "chip-btn", disabled: nudgedByMe,
        text: nudgedByMe ? `Nudged ${fmtTime(person.nudgedAt)}` : "Nudge",
        "aria-label": nudgedByMe ? `You nudged ${person.name} at ${fmtTime(person.nudgedAt)}` : `Nudge ${person.name}`,
        onClick: async (evt) => {
          const button = evt.currentTarget;
          button.disabled = true;
          if (await sync.sendNudge(person.id)) toast(`Nudged ${person.name}`);
          else button.disabled = false; // let them try again
        },
      })];
    });
  }

  function paintPlaceholder(card, title, text, unit) {
    card.el.classList.remove("is-me");
    card.el.classList.add("is-empty");
    card.name.textContent = title;
    card.pill.textContent = "";
    [card.reading, card.of, card.last].forEach((el) => { el.hidden = true; });
    card.empty.textContent = text;
    card.empty.hidden = false;
    card.vessel.paint({ totalMl: 0, goalMl: unit === "oz" ? 64 * ML_PER_OZ : DEFAULT_GOAL_ML, expectedMl: 0, showPace: false, unit });
    setActions(card, "none", () => []);
  }

  function renderTanks(model, unit) {
    const me = model.people.find((p) => p.isMe) || null;
    const slots = model.people.map((p) => ({ key: p.id, person: p }));
    if (!model.ready) slots.push({ key: "me-placeholder", title: "You", text: "Loading…" });
    if (slots.length < 2) {
      slots.push({
        key: "friend-placeholder", title: "Your friend",
        text: model.ready ? "Their glass appears here once they join." : "Loading…",
      });
    }
    const wanted = new Set(slots.map((s) => s.key));
    [...cards.keys()].filter((k) => !wanted.has(k)).forEach((k) => { cards.get(k).el.remove(); cards.delete(k); });

    slots.forEach((slot, i) => {
      if (!cards.has(slot.key)) cards.set(slot.key, createCard());
      const card = cards.get(slot.key);
      if (tanks.children[i] !== card.el) tanks.insertBefore(card.el, tanks.children[i] || null);
      if (slot.person) paintPerson(card, slot.person, me, unit);
      else paintPlaceholder(card, slot.title, slot.text, unit);
    });
  }

  function celebrate(model) {
    model.people.forEach((p) => {
      const met = p.status.kind === "done";
      const before = metBefore.get(p.id);
      metBefore.set(p.id, met);
      if (before !== false || !met) return; // only a change seen while the app is open
      const card = cards.get(p.id);
      if (card) {
        card.el.classList.add("is-celebrating");
        setTimeout(() => card.el.classList.remove("is-celebrating"), CELEBRATE_MS);
      }
      toast(p.isMe ? "Goal hit. Nice work." : `${p.name} hit their goal`);
    });
  }

  function renderPour(model, state) {
    const { unit, bottleMl } = state;
    const key = `${unit}|${bottleMl}`;
    if (presetKey !== key) {
      presetKey = key;
      const presets = unit === "oz"
        ? [{ label: "Cup", ml: 8 * ML_PER_OZ }, { label: "Bottle", ml: 16.9 * ML_PER_OZ }]
        : [{ label: "Glass", ml: 250 }, { label: "Bottle", ml: 500 }];
      quick.replaceChildren(...[...presets, { label: "My bottle", ml: bottleMl }].map((p) => h("button", {
        type: "button", class: "pour-btn",
        "aria-label": `Log ${p.label.toLowerCase()}, ${fmtAmount(p.ml, unit)}`,
        onClick: () => addDrink(p.ml),
      }, glassIcon(p.ml), h("span", { class: "label", text: p.label }), h("span", { class: "amt", text: fmtAmount(p.ml, unit) }))));
      custom.suffix.textContent = unit;
      custom.input.placeholder = unit === "oz" ? "12" : "330";
    }
    const canLog = model.ready && model.people.some((p) => p.isMe);
    quick.querySelectorAll("button").forEach((b) => { b.disabled = !canLog; });
    customForm.querySelectorAll("input, button").forEach((el) => { el.disabled = !canLog; });
    const mine = state.identity ? model.feed.filter((f) => f.memberId === state.identity.memberId) : [];
    undoBtn.disabled = !canLog || mine.length === 0;
  }

  function renderNotes(model, state) {
    const pending = model.pendingCount;
    const changes = pending === 1 ? "1 change" : `${pending} changes`;
    if (!state.online && pending > 0) syncNote.textContent = `Offline. ${changes} will sync when you're back online.`;
    else if (!state.online) syncNote.textContent = model.ready ? "Offline. Showing the last saved log." : "Offline. Connect to load your pact.";
    else if (state.trouble && pending > 0) syncNote.textContent = `The server isn't answering right now. ${changes} will sync when it does.`;
    else if (state.trouble) syncNote.textContent = "The server isn't answering right now. Showing the last saved log.";
    syncNote.hidden = state.online && !state.trouble;

    const me = model.people.find((p) => p.isMe);
    const nudger = me && me.nudgedBy ? model.people.find((p) => p.id === me.nudgedBy) : null;
    const fresh = me && me.nudgedAt && Date.now() - me.nudgedAt < NUDGE_TTL_MS;
    nudgeBanner.hidden = !(nudger && fresh);
    if (nudger && fresh) nudgeText.textContent = `${nudger.name} nudged you at ${fmtTime(me.nudgedAt)}. Time for a glass of water.`;
  }

  function draw() {
    const state = store.get();
    if (destroyed || !state.identity) return;
    const model = currentModel();
    const { unit } = state;

    dateLabel.textContent = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
    summary.textContent = summaryText(model, unit);
    renderNotes(model, state);
    renderTanks(model, unit);
    celebrate(model);
    renderPour(model, state);

    const alone = model.ready && model.people.length < 2;
    inviteCard.hidden = !alone;
    if (alone) inviteCode.textContent = formatCode(state.identity.code);
    installCard.hidden = !(platform.isMobile && !platform.isStandalone);

    // These lists are rebuilt only when what they show changed, so a redraw (every poll,
    // every minute) does not pull keyboard or screen-reader focus off a row.
    const names = model.people.map((p) => [p.id, p.name]);
    const nextFeedKey = JSON.stringify([unit, names, model.feed]);
    if (nextFeedKey !== feedKey) {
      feedKey = nextFeedKey;
      renderFeed({ list: feedList, empty: feedEmpty, model, unit, memberId: state.identity.memberId, onRemove: (id) => sync.removeDrink(id) });
    }
    const nextHistoryKey = JSON.stringify([model.ready, names, model.people.map((p) => p.streak), model.teamStreak, model.weeks]);
    if (nextHistoryKey !== historyKey) {
      historyKey = nextHistoryKey;
      renderHistory({ container: history, model });
    }
  }

  function drawIfQueued() {
    if (!queued) return;
    queued = false;
    draw();
  }

  /** Coalesces bursts of changes into one draw. */
  function update() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(drawIfQueued);
    // Animation frames pause while the app is in the background; this keeps it current anyway.
    setTimeout(drawIfQueued, RENDER_FALLBACK_MS);
  }

  // Keep pace labels and the date moving while the app sits open.
  const clock = setInterval(update, CLOCK_MS);

  draw();
  return Object.freeze({
    name: "home",
    update,
    destroy() {
      destroyed = true;
      clearInterval(clock);
      // A settings or install sheet left open would sit on top of the next screen.
      closeSheets();
    },
  });
}
