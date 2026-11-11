// Settings sheet: your name and goal, units, bottle size, inviting, linking a device, leaving.
import { LIMITS, cleanName, fmtNumber, formatCode } from "../logic.js";
import { refusalText } from "../sync.js";
import { field, fmtTime, h, openSheet, readAmount, setAmount, shareLink, switchAmountUnit, toast } from "./dom.js";

const APP_VERSION = "2.0.0";

/**
 * @param {{ api: object, store: object, sync: object, inviteUrl: (code: string) => string }} ctx
 */
export function openSettings(ctx) {
  const { api, store, sync } = ctx;
  const state = store.get();
  if (!state.identity) return;
  const me = state.pact ? state.pact.members.find((m) => m.id === state.identity.memberId) : null;

  const dialog = h("dialog", { class: "sheet", "aria-labelledby": "settings-title" });
  let dismiss = () => {};
  const close = () => dismiss();

  // ----- profile, bottle size and units -----
  const name = field({ id: "settings-name", label: "Your name", maxlength: LIMITS.nameMax, autocomplete: "given-name", value: me ? me.name : "" });
  const goal = field({ id: "settings-goal", label: "Daily goal", type: "number", inputmode: "decimal", step: "any", suffix: state.unit });
  const bottle = field({ id: "settings-bottle", label: "My bottle size", type: "number", inputmode: "decimal", step: "any", suffix: state.unit });
  if (me) setAmount(goal.input, me.goal_ml, state.unit);
  setAmount(bottle.input, state.bottleMl, state.unit);
  const error = h("p", { class: "error", role: "alert", hidden: true });
  const save = h("button", { type: "submit", class: "solid-btn", text: "Save" });
  const fail = (message) => { error.textContent = message; error.hidden = false; };

  const unitButtons = ["ml", "oz"].map((u) => h("button", {
    type: "button", text: u, "aria-pressed": String(state.unit === u),
    onClick: () => {
      const from = store.get().unit;
      if (from === u) return;
      // Keep what was typed, shown in the new unit.
      [goal, bottle].forEach((f) => {
        switchAmountUnit(f.input, from, u);
        f.suffix.textContent = u;
      });
      unitButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === u)));
      store.set({ unit: u });
    },
  }));

  const profileForm = h("form", {
    class: "panel", novalidate: true,
    onSubmit: async (evt) => {
      evt.preventDefault();
      const unit = store.get().unit;
      const cleanedName = cleanName(name.input.value);
      const parsedGoal = readAmount(goal.input, unit, LIMITS.goalMinMl, LIMITS.goalMaxMl);
      const parsedBottle = readAmount(bottle.input, unit, LIMITS.drinkMinMl, LIMITS.drinkMaxMl);
      if (!cleanedName) return fail("Enter your name so your friend knows it's you.");
      if (!parsedGoal.ok) return fail(`Pick a goal between ${fmtNumber(LIMITS.goalMinMl, unit)} and ${fmtNumber(LIMITS.goalMaxMl, unit)} ${unit}.`);
      if (!parsedBottle.ok) return fail(`Pick a bottle size between ${fmtNumber(LIMITS.drinkMinMl, unit)} and ${fmtNumber(LIMITS.drinkMaxMl, unit)} ${unit}.`);
      error.hidden = true;
      store.set({ bottleMl: parsedBottle.ml });

      const profileChanged = !me || cleanedName !== me.name || parsedGoal.ml !== me.goal_ml;
      if (profileChanged) {
        save.disabled = true;
        const result = await sync.saveProfile({ name: cleanedName, goalMl: parsedGoal.ml });
        save.disabled = false;
        // Shown here in the sheet: a message behind it could go unseen.
        if (!result.ok) return fail(result.message);
      }
      toast("Saved");
      close();
    },
  },
  name.wrap,
  h("div", { class: "goal-row" }, goal.wrap, h("div", { class: "units", role: "group", "aria-label": "Units" }, unitButtons)),
  bottle.wrap,
  error,
  save);

  // ----- invite -----
  const inviteLink = h("input", { class: "link-out", type: "text", readOnly: true, hidden: true, "aria-label": "Invite link" });
  const inviteStatus = h("p", { class: "hint", role: "status", hidden: true });
  const invite = h("section", { class: "panel" },
    h("h3", { text: "Invite a friend" }),
    h("div", { class: "code-box" },
      h("span", { class: "code-label", text: "Invite code" }),
      h("strong", { class: "code", text: formatCode(state.identity.code) })),
    h("button", {
      type: "button", class: "ghost-btn", text: "Share invite link",
      onClick: async () => {
        const url = ctx.inviteUrl(state.identity.code);
        const result = await shareLink({ title: "Water Pact", text: "Join my Water Pact so we both drink enough water.", url });
        if (result === "copied") inviteStatus.textContent = "Invite link copied. Paste it into a message to your friend.";
        if (result === "failed") {
          inviteLink.value = url;
          inviteLink.hidden = false;
          inviteLink.select();
          inviteStatus.textContent = "Copy this link and send it to your friend.";
        }
        inviteStatus.hidden = result === "shared" || result === "cancelled";
      },
    }),
    inviteStatus,
    inviteLink);

  // ----- link another device -----
  const linkOut = h("div", { class: "code-box", hidden: true });
  const linkButton = h("button", {
    type: "button", class: "ghost-btn", text: "Get a link code",
    onClick: async () => {
      linkButton.disabled = true;
      try {
        const { linkCode, expiresAt } = await api.createLinkCode(store.get().identity);
        linkOut.replaceChildren(
          h("span", { class: "code-label", text: "Link code" }),
          h("strong", { class: "code", text: formatCode(linkCode) }),
          h("span", { class: "hint", text: `Works once, until ${fmtTime(expiresAt)}. On the other device choose “Link this one” and type it in.` }));
      } catch (e) {
        linkOut.replaceChildren(h("span", { class: "error", role: "alert", text: refusalText(e.code) }));
      }
      linkOut.hidden = false;
      linkButton.disabled = false;
    },
  });
  const link = h("section", { class: "panel" },
    h("h3", { text: "Use on another device" }),
    h("p", { class: "hint", text: "Opens your log on a second phone, or in the installed app if you joined in the browser." }),
    linkButton,
    linkOut);

  // ----- leave -----
  let armed = false;
  const leaveButton = h("button", {
    type: "button", class: "danger-btn", text: "Leave this pact",
    onClick: async () => {
      if (!armed) {
        armed = true;
        leaveButton.textContent = "Tap again to delete your log and leave";
        return;
      }
      leaveButton.disabled = true;
      if (await sync.leave()) close();
      else leaveButton.disabled = false;
    },
  });
  const leave = h("section", { class: "panel" },
    h("h3", { text: "Leave" }),
    h("p", { class: "hint", text: "Leaving deletes your drinks from the pact for good. Your friend keeps theirs." }),
    leaveButton);

  dialog.append(
    h("div", { class: "sheet-head" },
      h("h2", { id: "settings-title", text: "Settings" }),
      h("button", { type: "button", class: "text-btn", text: "Close", onClick: close })),
    profileForm, invite, link, leave,
    h("p", { class: "hint version", text: `Water Pact ${APP_VERSION}` }));
  dismiss = openSheet(dialog);
}
