// Everything before you are in a pact: install, start one, join one, or link this device.
import {
  LIMITS, LINK_CODE_LENGTH, cleanName, deviceTimeZone, fmtNumber, formatCode,
  normalizeCode, ML_PER_OZ,
} from "../logic.js";
import { refusalText } from "../sync.js";
import { field, h, readAmount, setAmount, switchAmountUnit } from "./dom.js";
import { goalHelper } from "./goal-helper.js";
import { brandMark, installSteps } from "./install.js";

const DEFAULT_GOAL_ML = Object.freeze({ ml: 2000, oz: Math.round(64 * ML_PER_OZ) });

const joinFailure = (code) => {
  if (code === "wp_not_found") return "That invite doesn't work any more. Ask your friend for a new link.";
  if (code === "wp_invalid") return "Check your name and goal, then try again.";
  return refusalText(code);
};

function listNames(names) {
  if (names.length <= 2) return names.join(" and ");
  return `${names[0]} and ${names.length - 1} others`;
}

/**
 * @param {HTMLElement} root
 * @param {{ api: object, store: object, sync: object, platform: object, joinCode: () => string|null,
 *           setJoinCode: (code: string|null) => void, installPrompt: () => any }} ctx
 */
export function createOnboarding(root, ctx) {
  const { api, store, sync, platform } = ctx;
  let view = platform.isMobile && !platform.isStandalone && !store.get().installDismissed ? "install" : "welcome";
  let invitedBy = null;   // names in the pact behind the invite, once known
  let inviteDead = false;
  let mountedKey = "";
  let destroyed = false;

  function unitToggle(onChange) {
    const buttons = ["ml", "oz"].map((u) => h("button", {
      type: "button", text: u, "aria-pressed": String(store.get().unit === u),
      onClick: () => {
        const from = store.get().unit;
        if (from === u) return;
        store.set({ unit: u });
        buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === u)));
        onChange(from, u);
      },
    }));
    return h("div", { class: "units", role: "group", "aria-label": "Units" }, buttons);
  }

  function goalRangeText(unit) {
    return `Pick a goal between ${fmtNumber(LIMITS.goalMinMl, unit)} and ${fmtNumber(LIMITS.goalMaxMl, unit)} ${unit}.`;
  }

  function profileForm({ submitLabel, onSubmit }) {
    const unit = store.get().unit;
    const name = field({ id: "profile-name", label: "Your name", maxlength: LIMITS.nameMax, autocomplete: "given-name", placeholder: "What your friend calls you" });
    const goal = field({ id: "profile-goal", label: "Daily goal", type: "number", inputmode: "decimal", step: "any", suffix: unit });
    setAmount(goal.input, DEFAULT_GOAL_ML[unit], unit);
    const error = h("p", { class: "error", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "solid-btn", text: submitLabel });
    const helper = goalHelper({
      unit,
      onUse: (ml) => { setAmount(goal.input, ml, store.get().unit); goal.input.focus(); },
    });
    const toggle = unitToggle((from, to) => {
      switchAmountUnit(goal.input, from, to);
      goal.suffix.textContent = to;
      helper.switchUnit(from, to);
    });
    const fail = (message) => { error.textContent = message; error.hidden = false; };

    return h("form", {
      class: "panel", novalidate: true,
      onSubmit: async (evt) => {
        evt.preventDefault();
        const cleanedName = cleanName(name.input.value);
        const parsedGoal = readAmount(goal.input, store.get().unit, LIMITS.goalMinMl, LIMITS.goalMaxMl);
        if (!cleanedName) return fail("Enter your name so your friend knows it's you.");
        if (!parsedGoal.ok) return fail(goalRangeText(store.get().unit));
        error.hidden = true;
        submit.disabled = true;
        try {
          await onSubmit({ name: cleanedName, goalMl: parsedGoal.ml, tz: deviceTimeZone() });
        } catch (e) {
          fail(joinFailure(e.code));
          submit.disabled = false;
        }
      },
    },
    name.wrap,
    h("div", { class: "goal-row" }, goal.wrap, toggle),
    helper.root,
    error,
    submit);
  }

  function useIdentity(identity) {
    // The address becomes the invite link, which is also what a home-screen install remembers.
    history.replaceState(null, "", `#join=${identity.code}`);
    ctx.setJoinCode(identity.code);
    return sync.adopt(identity);
  }

  function linkButton() {
    return h("button", {
      type: "button", class: "text-btn", text: "Already joined on another device? Link this one",
      onClick: () => { view = "link"; mount(); },
    });
  }

  function installView() {
    const code = ctx.joinCode();
    return h("main", { class: "onboard" },
      brandMark(),
      h("h1", { text: invitedBy ? `${listNames(invitedBy)} invited you to Water Pact` : "Get Water Pact on your phone" }),
      h("p", { class: "lede", text: "Add it to your home screen first. It opens full screen with its own icon, like any other app." }),
      installSteps({ platform, installPrompt: ctx.installPrompt }),
      code && h("div", { class: "code-box" },
        h("span", { class: "code-label", text: "Your invite code" }),
        h("strong", { class: "code", text: formatCode(code) }),
        h("span", { class: "hint", text: "The app asks for this only if it doesn't open on your invite." })),
      h("button", {
        type: "button", class: "text-btn", text: "Continue in the browser instead",
        onClick: () => { store.set({ installDismissed: true }); view = "welcome"; mount(); },
      }));
  }

  function joinView(code) {
    if (inviteDead) {
      return h("main", { class: "onboard" },
        brandMark(),
        h("h1", { text: "This invite has expired" }),
        h("p", { class: "lede", text: "The pact behind this link no longer exists. Ask your friend for a new link, or start your own." }),
        h("button", {
          type: "button", class: "solid-btn", text: "Start your own pact",
          onClick: () => { history.replaceState(null, "", location.pathname); ctx.setJoinCode(null); mount(); },
        }),
        linkButton());
    }
    return h("main", { class: "onboard" },
      brandMark(),
      h("h1", { text: invitedBy ? `Join ${listNames(invitedBy)}` : "Join the pact" }),
      h("p", { class: "lede", text: "Set your daily goal. You'll each see the other's glass fill up as you log drinks." }),
      profileForm({
        submitLabel: "Join the pact",
        onSubmit: async (profile) => useIdentity(await api.joinPact({ code, ...profile })),
      }),
      linkButton());
  }

  function startView() {
    const notice = store.get().notice;
    const codeField = field({ id: "invite-code", label: "Invite code", autocomplete: "off", autocapitalize: "characters", placeholder: "ABCDE-FGHJK" });
    const codeError = h("p", { class: "error", role: "alert", hidden: true });
    return h("main", { class: "onboard" },
      brandMark(),
      notice && h("p", { class: "notice", text: notice }),
      h("h1", { text: "Drink enough water, together" }),
      h("p", { class: "lede", text: "Start a pact, send your friend the invite, and keep each other honest." }),
      profileForm({
        submitLabel: "Start a pact",
        onSubmit: async (profile) => useIdentity(await api.createPact(profile)),
      }),
      h("details", { class: "have-code" },
        h("summary", { text: "Have an invite code?" }),
        h("form", {
          class: "panel", novalidate: true,
          onSubmit: (evt) => {
            evt.preventDefault();
            const code = normalizeCode(codeField.input.value);
            if (!code) {
              codeError.textContent = "Invite codes are 10 letters and numbers, like ABCDE-FGHJK.";
              codeError.hidden = false;
              return;
            }
            history.replaceState(null, "", `#join=${code}`);
            ctx.setJoinCode(code);
            mount();
          },
        }, codeField.wrap, codeError, h("button", { type: "submit", class: "ghost-btn", text: "Continue" }))),
      linkButton());
  }

  function linkView() {
    const codeField = field({ id: "link-code", label: "Link code", autocomplete: "off", autocapitalize: "characters", placeholder: "ABCDE-FGHJK" });
    const error = h("p", { class: "error", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "solid-btn", text: "Link this device" });
    const fail = (message) => { error.textContent = message; error.hidden = false; };
    return h("main", { class: "onboard" },
      brandMark(),
      h("h1", { text: "Link this device" }),
      h("p", { class: "lede", text: "On the device where you already joined, open Settings and tap “Get a link code”. Enter it here within 10 minutes." }),
      h("form", {
        class: "panel", novalidate: true,
        onSubmit: async (evt) => {
          evt.preventDefault();
          const code = normalizeCode(codeField.input.value, LINK_CODE_LENGTH);
          if (!code) return fail("Link codes are 10 letters and numbers, like ABCDE-FGHJK.");
          error.hidden = true;
          submit.disabled = true;
          try {
            await useIdentity(await api.redeemLinkCode(code));
          } catch (e) {
            fail(e.code === "wp_not_found" ? "That code is wrong or has expired. Get a new one and try again." : refusalText(e.code));
            submit.disabled = false;
          }
        },
      }, codeField.wrap, error, submit),
      h("button", { type: "button", class: "text-btn", text: "Back", onClick: () => { view = "welcome"; mount(); } }));
  }

  async function lookUpInvite(code) {
    let names = null;
    let dead = false;
    try {
      names = (await api.peekPact(code)).names;
    } catch (e) {
      dead = e.code === "wp_not_found";
    }
    // The answer can arrive after the person has already joined and this screen is gone.
    if (destroyed || ctx.joinCode() !== code) return;
    // Rebuilding the screen clears what was typed, so only do it when there is something new to show.
    if (!dead && !(names && names.length)) return;
    invitedBy = names && names.length ? names : null;
    inviteDead = dead;
    mount();
  }

  // The install button only exists on the install view, so only that view depends on the prompt.
  const screenKey = () =>
    `${view}|${ctx.joinCode() || ""}|${view === "install" && Boolean(ctx.installPrompt())}`;

  function mount() {
    if (destroyed) return;
    const code = ctx.joinCode();
    const node = view === "install" ? installView()
      : view === "link" ? linkView()
      : code ? joinView(code) : startView();
    root.replaceChildren(node);
    mountedKey = screenKey();
  }

  let lookedUp = null;
  function update() {
    const code = ctx.joinCode();
    if (code !== lookedUp) {
      lookedUp = code;
      invitedBy = null;
      inviteDead = false;
      if (code) lookUpInvite(code);
    }
    // Forms hold what the person typed, so only rebuild when the screen itself changes.
    if (screenKey() !== mountedKey) mount();
  }

  update();
  return Object.freeze({ name: "onboarding", update, destroy() { destroyed = true; } });
}
