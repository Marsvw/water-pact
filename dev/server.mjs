// Local stand-in for hosting + Supabase: serves the app's files and answers
// /rest/v1/rpc/* from an in-memory Postgres running the real schema.
// Start with: npm run dev   (data resets every time it restarts)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase, rpc } from "./pg.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;
const RPC_PREFIX = "/rest/v1/rpc/";
const TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
});
// Only the app itself is served; tests, tooling and dependencies stay private.
const PUBLIC = [/^index\.html$/, /^styles\.css$/, /^sw\.js$/, /^manifest\.webmanifest$/, /^js\//, /^icons\//];
const DEV_CONFIG = 'export const CONFIG = Object.freeze({ supabaseUrl: location.origin, supabaseKey: "dev-key" });\n';

const db = await createDatabase();

function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
const sendJson = (res, status, value) => send(res, status, TYPES[".json"], JSON.stringify(value));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleRpc(req, res, fn) {
  let args;
  try {
    args = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { code: "PGRST102", message: "invalid body" });
  }
  try {
    return sendJson(res, 200, await rpc(db, fn, args));
  } catch (e) {
    // Same shape Supabase returns when a function raises.
    return sendJson(res, 400, { code: "P0001", message: String(e.message || "error") });
  }
}

async function handleFile(res, pathname) {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "") || "index.html";
  if (relative === "config.js") return send(res, 200, TYPES[".js"], DEV_CONFIG);
  const allowed = !relative.split(sep).includes("..") && PUBLIC.some((rule) => rule.test(relative.split(sep).join("/")));
  if (!allowed) return send(res, 404, "text/plain; charset=utf-8", "Not found");
  try {
    const body = await readFile(join(ROOT, relative));
    return send(res, 200, TYPES[extname(relative)] || "application/octet-stream", body);
  } catch {
    return send(res, 404, "text/plain; charset=utf-8", "Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${HOST}:${PORT}`);
    if (pathname.startsWith(RPC_PREFIX)) {
      if (req.method !== "POST") return send(res, 405, "text/plain; charset=utf-8", "Method not allowed");
      return await handleRpc(req, res, pathname.slice(RPC_PREFIX.length));
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain; charset=utf-8", "Method not allowed");
    return await handleFile(res, pathname);
  } catch {
    return send(res, 500, "text/plain; charset=utf-8", "Server error");
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Water Pact dev server: http://localhost:${PORT}\n`);
});
