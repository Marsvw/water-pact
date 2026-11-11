// Talks to the shared database through its wp_* functions (Supabase REST).
// Every answer is checked before the app uses it.

/**
 * @typedef {{ code: string, memberId: string, key: string }} Identity
 * @typedef {{ id: string, ml: number, at: string, day: string }} Drink
 */

/**
 * code says what to do about it:
 *   "network"  no connection reached the server; keep the change and retry
 *   "busy"     the server answered but cannot take it right now; keep and retry
 *   "server"   an answer the app does not understand; do not retry
 *   "wp_*"     the database refused, for the stated reason; do not retry
 */
export class ApiError extends Error {
  constructor(code, detail = "") {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.detail = detail;
  }
}

const REFUSALS = new Set(["wp_auth", "wp_not_found", "wp_full", "wp_invalid", "wp_limit"]);
const RETRY_LATER_STATUS = new Set([408, 425, 429]);
const DEFAULT_TIMEOUT_MS = 12000;

const isText = (v) => typeof v === "string" && v.length > 0;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function toIdentity(body) {
  if (!isObject(body) || !isText(body.code) || !isText(body.member_id) || !isText(body.member_key)) {
    throw new ApiError("server");
  }
  return { code: body.code, memberId: body.member_id, key: body.member_key };
}

function toMember(m) {
  if (!isObject(m) || !isText(m.id) || !isText(m.name) || !Number.isFinite(m.goal_ml)) return null;
  return {
    id: m.id,
    name: m.name,
    goal_ml: m.goal_ml,
    tz: isText(m.tz) ? m.tz : "UTC",
    joined_at: isText(m.joined_at) ? m.joined_at : "",
    nudged_by: isText(m.nudged_by) ? m.nudged_by : null,
    nudged_at: isText(m.nudged_at) ? m.nudged_at : null,
  };
}

function toDay(d) {
  const ok = isObject(d) && isText(d.member_id) && isText(d.day) && Number.isFinite(d.total_ml) && Number.isFinite(d.goal_ml);
  return ok ? { member_id: d.member_id, day: d.day, total_ml: d.total_ml, goal_ml: d.goal_ml } : null;
}

function toEntry(e) {
  const ok = isObject(e) && isText(e.id) && isText(e.member_id) && isText(e.day) && isText(e.at)
    && Number.isFinite(e.ml) && Number.isFinite(e.goal_ml) && Number.isFinite(Date.parse(e.at));
  return ok ? { id: e.id, member_id: e.member_id, ml: e.ml, goal_ml: e.goal_ml, at: e.at, day: e.day } : null;
}

const keep = (list, convert) => (Array.isArray(list) ? list.map(convert).filter(Boolean) : []);

function toPact(body) {
  if (!isObject(body) || !Number.isFinite(body.rev)) throw new ApiError("server");
  if (body.unchanged === true) return { unchanged: true, rev: body.rev };
  if (!isText(body.since) || !isText(body.recent_from)) throw new ApiError("server");
  return {
    unchanged: false,
    rev: body.rev,
    since: body.since,
    recentFrom: body.recent_from,
    members: keep(body.members, toMember),
    days: keep(body.days, toDay),
    entries: keep(body.entries, toEntry),
  };
}

function toNames(body) {
  if (!isObject(body) || !Array.isArray(body.names)) throw new ApiError("server");
  return { names: body.names.filter(isText) };
}

function toLinkCode(body) {
  if (!isObject(body) || !isText(body.link_code) || !Number.isFinite(Date.parse(body.expires_at))) {
    throw new ApiError("server");
  }
  return { linkCode: body.link_code, expiresAt: Date.parse(body.expires_at) };
}

/**
 * @param {{ url: string, key: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 */
export function createApi({ url, key, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const endpoint = `${url.replace(/\/+$/, "")}/rest/v1/rpc/`;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  async function rpc(fn, args) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(endpoint + fn, {
        method: "POST", headers, body: JSON.stringify(args), signal: controller.signal,
      });
    } catch {
      throw new ApiError("network");
    } finally {
      clearTimeout(timer);
    }

    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.ok) return body;

    const message = isObject(body) && typeof body.message === "string" ? body.message : "";
    if (REFUSALS.has(message)) throw new ApiError(message);
    const retryLater = message === "wp_busy" || res.status >= 500 || RETRY_LATER_STATUS.has(res.status);
    throw new ApiError(retryLater ? "busy" : "server", message);
  }

  const auth = (identity) => ({ p_member_id: identity.memberId, p_key: identity.key });

  return Object.freeze({
    /** @returns {Promise<Identity>} */
    createPact: async ({ name, goalMl, tz }) =>
      toIdentity(await rpc("wp_create_pact", { p_name: name, p_goal_ml: goalMl, p_tz: tz })),

    /** @returns {Promise<Identity>} */
    joinPact: async ({ code, name, goalMl, tz }) =>
      toIdentity(await rpc("wp_join_pact", { p_code: code, p_name: name, p_goal_ml: goalMl, p_tz: tz })),

    /** @returns {Promise<{ names: string[] }>} */
    peekPact: async (code) => toNames(await rpc("wp_peek_pact", { p_code: code })),

    getPact: async ({ code, since, recentFrom, rev }) =>
      toPact(await rpc("wp_get_pact", { p_code: code, p_since: since, p_recent_from: recentFrom, p_rev: rev ?? null })),

    /** @param {Identity} identity @param {Drink} drink */
    logDrink: (identity, drink) =>
      rpc("wp_log_drink", { ...auth(identity), p_id: drink.id, p_ml: drink.ml, p_at: drink.at, p_day: drink.day }),

    removeDrink: (identity, id) => rpc("wp_remove_drink", { ...auth(identity), p_id: id }),

    updateMember: (identity, { name, goalMl, tz }) =>
      rpc("wp_update_member", { ...auth(identity), p_name: name, p_goal_ml: goalMl, p_tz: tz }),

    sendNudge: (identity, toMemberId) => rpc("wp_send_nudge", { ...auth(identity), p_to: toMemberId }),

    clearNudge: (identity) => rpc("wp_clear_nudge", auth(identity)),

    leavePact: (identity) => rpc("wp_leave_pact", auth(identity)),

    createLinkCode: async (identity) => toLinkCode(await rpc("wp_create_link_code", auth(identity))),

    /** @returns {Promise<Identity>} */
    redeemLinkCode: async (linkCode) =>
      toIdentity(await rpc("wp_redeem_link_code", { p_link_code: linkCode })),
  });
}
