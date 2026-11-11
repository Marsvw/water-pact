// Today's shared log, the streak tiles and the four-week calendar.
import { fmtAmount, keyToDate } from "../logic.js";
import { fmtTime, h } from "./dom.js";

const displayName = (person) => (person.isMe ? "You" : person.name);

/**
 * @param {{ list: HTMLElement, empty: HTMLElement, model: object, unit: string, memberId: string, onRemove: (id: string) => void }} args
 */
export function renderFeed({ list, empty, model, unit, memberId, onRemove }) {
  const people = new Map(model.people.map((p) => [p.id, p]));
  const rows = model.feed.map((entry) => {
    const person = people.get(entry.memberId);
    const mine = entry.memberId === memberId;
    const amount = fmtAmount(entry.ml, unit);
    return h("li", {},
      h("span", { class: `dot ${mine ? "is-me" : "is-friend"}` }),
      h("span", { class: "who", text: person ? displayName(person) : "Someone" }),
      h("span", { class: "amt", text: amount }),
      h("span", { class: "time", text: entry.pending ? "Saving…" : fmtTime(entry.at) }),
      mine
        ? h("button", {
          type: "button", class: "remove", text: "×",
          "aria-label": `Remove ${amount} at ${fmtTime(entry.at)}`,
          onClick: () => onRemove(entry.id),
        })
        : h("span", { "aria-hidden": "true" })); // keeps the columns lined up
  });
  list.replaceChildren(...rows);
  empty.hidden = rows.length > 0;
}

function streakTile(count, label, isTeam = false) {
  return h("div", { class: `tile${isTeam ? " is-team" : ""}` },
    h("span", { class: "tile-num", text: String(count) }),
    h("span", { class: "tile-label", text: label }));
}

function dayCell(day, names) {
  if (day.isFuture) return h("div", { class: "day is-future", "aria-hidden": "true" });
  const date = keyToDate(day.key);
  const when = date.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  // Colour alone carries "goal hit" on screen, so the same thing is said in words.
  const who = day.bars.map((bar, i) => `${names[i]} ${bar.met ? "hit the goal" : `${Math.round(bar.ratio * 100)}%`}`);
  return h("div", {
    class: `day${day.isToday ? " is-today" : ""}`,
    role: "img",
    title: when,
    "aria-label": `${when}: ${who.join(", ")}`,
  },
  h("span", { class: "day-num", text: String(date.getDate()) }),
  h("span", { class: "bars" }, day.bars.map((bar) =>
    h("span", { class: `bar${bar.met ? " is-met" : ""}` },
      h("span", { class: "bar-fill", style: `height: ${Math.round(bar.ratio * 100)}%` })))));
}

/**
 * @param {{ container: HTMLElement, model: object }} args
 */
export function renderHistory({ container, model }) {
  if (!model.ready) {
    container.replaceChildren(h("p", { class: "hint", text: "Your history shows up here once the log loads." }));
    return;
  }
  const tiles = model.people.map((p) => streakTile(p.streak, `${displayName(p)}${p.isMe ? "r" : "'s"} streak`));
  if (model.teamStreak !== null) tiles.push(streakTile(model.teamStreak, "Team streak", true));

  const weekdayHeads = model.weeks[0].map((day) =>
    h("span", { class: "weekday", text: keyToDate(day.key).toLocaleDateString([], { weekday: "narrow" }) }));

  const order = model.people.map(displayName);
  const legend = order.length > 1
    ? `Bars in each day, left to right: ${order.join(", ")}. Green means the goal was hit.`
    : "One bar per day. Green means the goal was hit.";
  const streakNote = model.teamStreak === null
    ? "A streak is days in a row with the goal hit."
    : "A streak is days in a row with the goal hit. The team streak needs everyone on the same day.";

  container.replaceChildren(
    h("div", { class: "tiles" }, tiles),
    h("div", { class: "calendar" }, weekdayHeads, model.weeks.flat().map((day) => dayCell(day, order))),
    h("p", { class: "hint", text: `${legend} ${streakNote}` }));
}
