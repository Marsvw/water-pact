// A real Postgres (compiled to WebAssembly) loaded with the app's schema.
// Used by the tests and by the local dev server, so both exercise the same SQL
// that runs on Supabase.
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const SCHEMA_URL = new URL("../supabase/schema.sql", import.meta.url);

// Supabase ships these roles; a bare Postgres does not.
const SUPABASE_ROLES = "create role anon nologin; create role authenticated nologin;";

const FUNCTION_NAME = /^wp_[a-z_]+$/;
const ARG_NAME = /^p_[a-z_]+$/;

export async function createDatabase() {
  const db = new PGlite();
  await db.exec(SUPABASE_ROLES);
  await db.exec(await readFile(SCHEMA_URL, "utf8"));
  // Everything after setup runs as the public API role, like a phone would.
  await db.exec("set role anon");
  return db;
}

/** Calls a wp_* function the way the Supabase REST API does: named arguments in, JSON out. */
export async function rpc(db, fn, args = {}) {
  const names = Object.keys(args);
  if (!FUNCTION_NAME.test(fn) || !names.every((n) => ARG_NAME.test(n))) {
    throw Object.assign(new Error("wp_invalid"), { code: "P0001" });
  }
  const list = names.map((n, i) => `${n} => $${i + 1}`).join(", ");
  const res = await db.query(`select public.${fn}(${list}) as result`, names.map((n) => args[n]));
  return res.rows[0].result;
}

/** Runs a query as the database owner, for assertions the public role cannot make. */
export async function asOwner(db, sql, params = []) {
  await db.exec("reset role");
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("set role anon");
  }
}

/**
 * A fetch stand-in that answers like the Supabase REST API, backed by this database.
 * Lets the app's own client code run against the real schema without a network.
 */
export function databaseFetch(db) {
  const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  return async (url, init) => {
    const fn = new URL(url).pathname.split("/").pop();
    try {
      return respond(200, await rpc(db, fn, JSON.parse(init.body)));
    } catch (e) {
      return respond(400, { code: "P0001", message: e.message });
    }
  };
}
