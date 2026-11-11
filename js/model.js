// Turns the pact data from the server, plus anything still waiting to sync,
// into exactly what the screens draw. Pure: same input, same output.
import {
  HISTORY_DAYS, calendarWeeks, expectedMl, fmtAmount, paceStatus, streak, zonedNow,
} from "./logic.js";

const CALENDAR_WEEKS = 4;
const EMPTY_MODEL = Object.freeze({
  ready: false, todayKey: null, people: [], teamStreak: null, feed: [], weeks: [], pendingCount: 0,
});

/** Server entries with this device's unsent drinks added and unsent removals taken out. */
export function applyOutbox(entries, outbox, memberId) {
  return outbox.reduce((list, op) => {
    if (op.type === "remove") return list.filter((e) => e.id !== op.id);
    if (list.some((e) => e.id === op.id)) return list;
    return [...list, { id: op.id, member_id: memberId, ml: op.ml, goal_ml: op.goalMl, at: op.at, day: op.day, pending: true }];
  }, [...entries]);
}

function indexDays(days) {
  return new Map(days.map((d) => [`${d.member_id}|${d.day}`, d]));
}

function orderMembers(members, memberId) {
  return [...members].sort((a, b) => {
    if (a.id === memberId) return -1;
    if (b.id === memberId) return 1;
    return String(a.joined_at).localeCompare(String(b.joined_at)) || a.id.localeCompare(b.id);
  });
}

export function buildModel({ pact, outbox, memberId, now, deviceTz }) {
  if (!pact) return EMPTY_MODEL;

  const entries = applyOutbox(pact.entries, outbox, memberId);
  const dayIndex = indexDays(pact.days);
  const entriesOn = (id, key) => entries.filter((e) => e.member_id === id && e.day === key);

  const members = orderMembers(pact.members, memberId).map((m) => {
    const clock = zonedNow(now, m.id === memberId ? deviceTz : m.tz);
    return { ...m, todayKey: clock.key, hours: clock.hours };
  });

  // Recent days are known drink by drink; older ones only as a total.
  const dayOf = (m, key) => {
    if (key >= pact.recentFrom) {
      const list = entriesOn(m.id, key);
      const totalMl = list.reduce((t, e) => t + e.ml, 0);
      const latest = list.reduce((a, b) => (a && a.at >= b.at ? a : b), null);
      // Today is measured against the current goal; past days keep the goal in force then.
      const goalMl = key === m.todayKey || !latest ? m.goal_ml : latest.goal_ml;
      return { totalMl, goalMl };
    }
    const row = dayIndex.get(`${m.id}|${key}`);
    return row ? { totalMl: row.total_ml, goalMl: row.goal_ml } : { totalMl: 0, goalMl: m.goal_ml };
  };
  const metOn = (m, key) => {
    const d = dayOf(m, key);
    return d.totalMl >= d.goalMl;
  };

  const people = members.map((m) => {
    const today = dayOf(m, m.todayKey);
    const todays = entriesOn(m.id, m.todayKey);
    return {
      id: m.id,
      name: m.name,
      isMe: m.id === memberId,
      goalMl: today.goalMl,
      todayKey: m.todayKey,
      totalMl: today.totalMl,
      expectedMl: expectedMl(today.goalMl, m.hours),
      status: paceStatus(today.totalMl, today.goalMl, m.hours),
      lastAt: todays.reduce((latest, e) => Math.max(latest, Date.parse(e.at)), 0),
      streak: streak((key) => metOn(m, key), m.todayKey, HISTORY_DAYS),
      nudgedBy: m.nudged_by,
      nudgedAt: m.nudged_at ? Date.parse(m.nudged_at) : null,
    };
  });

  const me = members.find((m) => m.id === memberId);
  const todayKey = me ? me.todayKey : zonedNow(now, deviceTz).key;

  const feed = members
    .flatMap((m) => entriesOn(m.id, m.todayKey))
    .map((e) => ({ id: e.id, memberId: e.member_id, ml: e.ml, at: Date.parse(e.at), pending: Boolean(e.pending) }))
    .sort((a, b) => b.at - a.at);

  const weeks = calendarWeeks(todayKey, CALENDAR_WEEKS).map((week) =>
    week.map((key) => ({
      key,
      isToday: key === todayKey,
      isFuture: key > todayKey,
      bars: members.map((m) => {
        const d = dayOf(m, key);
        return { memberId: m.id, ratio: Math.min(1, d.totalMl / d.goalMl), met: d.totalMl >= d.goalMl };
      }),
    })));

  return {
    ready: true,
    todayKey,
    people,
    teamStreak: members.length >= 2
      ? streak((key) => members.every((m) => metOn(m, key)), todayKey, HISTORY_DAYS)
      : null,
    feed,
    weeks,
    pendingCount: outbox.length,
  };
}

export function statusLabel(status, unit, locale) {
  if (status.kind === "done") return "Goal hit";
  if (status.kind === "pace") return "On pace";
  if (status.kind === "idle") return "Not started";
  return `Behind ${fmtAmount(status.behindMl, unit, locale)}`;
}

/** One sentence that says where the pact stands right now. */
export function summaryText(model, unit, locale) {
  if (!model.ready) return "Loading today's log…";
  const amount = (ml) => fmtAmount(ml, unit, locale);
  const left = (p) => Math.max(0, p.goalMl - p.totalMl);
  const me = model.people.find((p) => p.isMe);
  const others = model.people.filter((p) => !p.isMe);
  if (!me) return "Loading today's log…";

  if (others.length === 0) {
    const mine = left(me) === 0 ? "You hit your goal today." : `You need ${amount(left(me))} more today.`;
    return `${mine} Invite your friend to get the pact going.`;
  }
  if (others.length === 1) {
    const friend = others[0];
    if (left(me) === 0 && left(friend) === 0) return "You both hit your goal today.";
    if (left(me) === 0) return `You hit your goal. ${friend.name} still needs ${amount(left(friend))}.`;
    if (left(friend) === 0) return `${friend.name} hit their goal. You need ${amount(left(me))} more.`;
    return `You need ${amount(left(me))} more. ${friend.name} needs ${amount(left(friend))}.`;
  }
  const done = model.people.filter((p) => left(p) === 0).length;
  return `${done} of ${model.people.length} people have hit their goal today.`;
}
