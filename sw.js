// Offline shell. The app's own files are cached as one complete set per release
// and always served from that set, so a phone never runs a mix of old and new files.
// Database calls are never cached.
//
// Releasing a new version: change VERSION. Phones notice this file changed, download
// the whole new set, and switch to it in one step the next time the app opens.
const VERSION = "2.0.1";
const SHELL_CACHE = `water-pact-shell-${VERSION}`;
const FONT_CACHE = "water-pact-fonts-1";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "config.js",
  "manifest.webmanifest",
  "js/main.js",
  "js/api.js",
  "js/logic.js",
  "js/model.js",
  "js/store.js",
  "js/sync.js",
  "js/ui/dom.js",
  "js/ui/history.js",
  "js/ui/home.js",
  "js/ui/install.js",
  "js/ui/onboarding.js",
  "js/ui/settings.js",
  "js/ui/vessel.js",
  "icons/favicon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  // "reload" skips the browser's own HTTP cache, so the set really is the new release.
  // addAll is all-or-nothing: if one file fails, the old version stays in charge.
  const fresh = SHELL.map((path) => new Request(path, { cache: "reload" }));
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  const keep = [SHELL_CACHE, FONT_CACHE];
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => !keep.includes(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function fromShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  if (request.mode === "navigate") {
    const index = await cache.match("index.html");
    if (index) return index;
  }
  return fetch(request);
}

async function fromFonts(event) {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  const response = await fetch(event.request);
  // Only complete, readable answers are kept; an error page must not become the font.
  if (response.status === 200) event.waitUntil(cache.put(event.request, response.clone()));
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (!url.pathname.includes("/rest/")) event.respondWith(fromShell(request));
    return;
  }
  if (FONT_HOSTS.includes(url.hostname)) event.respondWith(fromFonts(event));
});
