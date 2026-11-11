// Keeps this device and the shared database in step: fetches the pact,
// queues changes made offline, and sends them when a connection is back.
import { HISTORY_DAYS, RECENT_DAYS, deviceTimeZone, newId, shiftKey, zonedNow } from "./logic.js";
import { applyOutbox } from "./model.js";

const POLL_MS = 20000;
const MIN_EVENT_GAP_MS = 3000;
const MAX_ENTRIES_PER_DAY = 60;
// How many times one queued change may hit a busy server before it is let go,
// so a change the server can never take does not block everything behind it.
const MAX_BUSY_TRIES = 8;
const UNLINKED = "This device is no longer linked to the pact.";

const REFUSAL_TEXT = Object.freeze({
  wp_invalid: "That change couldn't be saved, so it was skipped.",
  wp_limit: "That's the most drinks one day can hold. Remove a few to add more.",
  wp_full: "This pact is full.",
  busy: "The server is busy right now. Try again in a moment.",
  server: "Something went wrong on the server. Try again in a moment.",
  network: "You're offline. Try again when you're connected.",
});
export const refusalText = (code) => REFUSAL_TEXT[code] || REFUSAL_TEXT.server;

/**
 * @param {{ api: object, store: object, notify: (message: string) => void }} deps
 */
export function createSync({ api, store, notify }) {
  let timer = 0;
  let lastTickAt = 0;
  let refreshRun = null;     // the fetch in progress, if any
  let refreshAgain = false;  // a newer fetch was asked for while one was running
  let flushRun = null;       // the flush in progress, if any
  let flushAgain = false;    // something asked for a flush while one was running
  let zonePushed = "";       // member and time zone already reported this session
  const busyTries = new Map(); // opId -> times the server was too busy for it

  const identity = () => store.get().identity;
  const me = () => {
    const { pact, identity: id } = store.get();
    return pact && id ? pact.members.find((m) => m.id === id.memberId) || null : null;
  };

  /** Records how the connection is doing, without waking listeners when nothing changed. */
  function setLink(online, trouble) {
    const state = store.get();
    if (state.online !== online || state.trouble !== trouble) store.set({ online, trouble });
  }

  /** Forget this device's membership, for example after leaving or being removed. */
  function signOut(notice = null) {
    busyTries.clear();
    store.set({ identity: null, pact: null, outbox: [], notice });
  }

  /** A phone that travelled reports its new zone, so friends see the right "today" for it. */
  function reportTimeZone(id, pact) {
    const tz = deviceTimeZone();
    const mine = pact.members.find((m) => m.id === id.memberId);
    const marker = `${id.memberId}|${tz}`;
    if (!mine || mine.tz === tz || zonePushed === marker) return;
    zonePushed = marker; // once per session, so a refusal cannot loop
    api.updateMember(id, { name: mine.name, goalMl: mine.goal_ml, tz })
      .then(() => refresh({ force: true }), () => { /* not urgent; the next session tries again */ });
  }

  async function refreshOnce(force) {
    const id = identity();
    if (!id) return;
    const outboxAtStart = store.get().outbox;
    const todayKey = zonedNow(new Date(), deviceTimeZone()).key;
    const since = shiftKey(todayKey, -HISTORY_DAYS);
    const recentFrom = shiftKey(todayKey, -RECENT_DAYS);
    const prev = store.get().pact;
    const sameWindow = prev && prev.recentFrom === recentFrom;

    let data;
    try {
      data = await api.getPact({ code: id.code, since, recentFrom, rev: !force && sameWindow ? prev.rev : null });
    } catch (e) {
      if (identity() !== id) return; // signed out or switched while waiting
      if (e.code === "wp_not_found") signOut("That pact no longer exists.");
      else if (e.code === "network") setLink(false, false);
      else if (e.code === "busy") setLink(true, true);
      return;
    }
    if (identity() !== id) return;
    // A change was queued or saved while this answer was on its way, so it may
    // be older than what the screen shows. Ask again rather than step backwards.
    if (store.get().outbox !== outboxAtStart) {
      refreshAgain = true;
      return;
    }
    if (data.unchanged) {
      setLink(true, false);
      return;
    }
    if (!data.members.some((m) => m.id === id.memberId)) {
      signOut("You're no longer in that pact on this device.");
      return;
    }
    const { unchanged, ...pact } = data;
    store.set({ pact, online: true, trouble: false });
    reportTimeZone(id, pact);
  }

  /**
   * Fetches the pact. A call made while a fetch is running joins it; a forced one
   * also makes it fetch once more afterwards, so its caller never gets an older answer.
   */
  function refresh({ force = false } = {}) {
    if (refreshRun) {
      if (force) refreshAgain = true;
      return refreshRun;
    }
    refreshRun = (async () => {
      let forceNext = force;
      do {
        refreshAgain = false;
        await refreshOnce(forceNext);
        forceNext = true;
      } while (refreshAgain);
    })().finally(() => { refreshRun = null; });
    return refreshRun;
  }

  function send(op, id) {
    if (op.type === "remove") return api.removeDrink(id, op.id);
    return api.logDrink(id, { id: op.id, ml: op.ml, at: op.at, day: op.day });
  }

  /**
   * Decides what a failed send means for the queue.
   * @returns {"wait" | "stop" | "drop"}
   */
  function afterFailure(error, op) {
    if (error.code === "network") {
      setLink(false, false);
      return "wait";
    }
    if (error.code === "wp_auth") {
      signOut(UNLINKED);
      return "stop";
    }
    if (error.code === "busy") {
      const tries = (busyTries.get(op.opId) || 0) + 1;
      busyTries.set(op.opId, tries);
      if (tries < MAX_BUSY_TRIES) {
        setLink(true, true);
        return "wait";
      }
    }
    notify(refusalText(error.code === "busy" ? "wp_invalid" : error.code));
    return "drop";
  }

  /** One pass over the queue, oldest first. Stops at the first failure worth retrying and keeps the rest. */
  async function flushOnce() {
    let settledAny = false;
    while (true) {
      const id = identity();
      const op = store.get().outbox[0];
      if (!id || !op) break;
      let accepted = true;
      try {
        await send(op, id);
      } catch (e) {
        const verdict = afterFailure(e, op);
        if (verdict !== "drop") break;
        accepted = false;
      }
      if (identity() !== id) break;
      busyTries.delete(op.opId);
      const { outbox, pact } = store.get();
      // Fold an accepted change into the local copy so it doesn't flicker before the next fetch.
      const settled = accepted && pact
        ? { ...pact, entries: applyOutbox(pact.entries, [op], id.memberId).map(({ pending, ...entry }) => entry) }
        : pact;
      store.set({ outbox: outbox.filter((o) => o.opId !== op.opId), pact: settled, online: true, trouble: false });
      settledAny = true;
    }
    if (settledAny) await refresh({ force: true });
    return settledAny;
  }

  /**
   * Sends queued changes. A call made while a flush is running joins it and makes it
   * take one more pass, so a change queued (or a connection regained) mid-flush is not missed.
   * @returns {Promise<boolean>} whether the pact was fetched again afterwards
   */
  function flush() {
    if (flushRun) {
      flushAgain = true;
      return flushRun;
    }
    flushRun = (async () => {
      let refreshed = false;
      do {
        flushAgain = false;
        refreshed = (await flushOnce()) || refreshed;
      } while (flushAgain);
      return refreshed;
    })().finally(() => { flushRun = null; });
    return flushRun;
  }

  async function tick() {
    lastTickAt = Date.now();
    if (!(await flush())) await refresh();
  }

  /** For focus and visibility events, which often fire together. */
  function tickIfDue() {
    if (!document.hidden && Date.now() - lastTickAt >= MIN_EVENT_GAP_MS) tick();
  }

  function enqueue(op) {
    store.set({ outbox: [...store.get().outbox, op] });
    flush();
  }

  /** @returns {boolean} whether the drink was accepted locally */
  function logDrink(ml) {
    const id = identity();
    const member = me();
    if (!id || !member) return false;
    const day = zonedNow(new Date(), deviceTimeZone()).key;
    const { pact, outbox } = store.get();
    const todays = applyOutbox(pact.entries, outbox, id.memberId)
      .filter((e) => e.member_id === id.memberId && e.day === day);
    if (todays.length >= MAX_ENTRIES_PER_DAY) {
      notify(REFUSAL_TEXT.wp_limit);
      return false;
    }
    enqueue({
      opId: newId(), type: "log", id: newId(), ml: Math.round(ml),
      goalMl: member.goal_ml, at: new Date().toISOString(), day,
    });
    return true;
  }

  function removeDrink(drinkId) {
    if (!identity()) return;
    enqueue({ opId: newId(), type: "remove", id: drinkId });
  }

  /**
   * Runs a change that needs the server now (it is not queued).
   * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
   */
  async function direct(action) {
    const id = identity();
    if (!id) return { ok: false, message: UNLINKED };
    try {
      await action(id);
    } catch (e) {
      if (e.code === "wp_auth") signOut(UNLINKED);
      return { ok: false, message: e.code === "wp_auth" ? UNLINKED : refusalText(e.code) };
    }
    await refresh({ force: true });
    return { ok: true };
  }

  /** Like direct(), for actions with no form of their own: failure shows as a message. */
  async function directOrNotify(action) {
    const result = await direct(action);
    if (!result.ok) notify(result.message);
    return result.ok;
  }

  const saveProfile = ({ name, goalMl }) =>
    direct((id) => api.updateMember(id, { name, goalMl, tz: deviceTimeZone() }));
  const sendNudge = (toMemberId) => directOrNotify((id) => api.sendNudge(id, toMemberId));
  const clearNudge = () => directOrNotify((id) => api.clearNudge(id));

  async function leave() {
    const id = identity();
    if (!id) return false;
    try {
      await api.leavePact(id);
    } catch (e) {
      if (e.code !== "wp_auth") {
        notify(refusalText(e.code));
        return false;
      }
    }
    signOut(null);
    return true;
  }

  /** Start using an identity on this device (after creating, joining or linking). */
  function adopt(newIdentity) {
    busyTries.clear();
    store.set({ identity: newIdentity, pact: null, outbox: [], notice: null });
    return refresh({ force: true });
  }

  function start() {
    tick();
    timer = setInterval(() => { if (!document.hidden) tick(); }, POLL_MS);
    document.addEventListener("visibilitychange", tickIfDue);
    window.addEventListener("online", tick);
    window.addEventListener("focus", tickIfDue);
  }

  function stop() {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", tickIfDue);
    window.removeEventListener("online", tick);
    window.removeEventListener("focus", tickIfDue);
  }

  return Object.freeze({
    start, stop, refresh, flush, adopt, signOut,
    logDrink, removeDrink, saveProfile, sendNudge, clearNudge, leave,
  });
}
