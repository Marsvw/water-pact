// Entry point: wires storage, the database client and the screens together.
import { CONFIG } from "../config.js";
import { createApi } from "./api.js";
import { parseJoinHash } from "./logic.js";
import { createStore, loadSaved, persist, persistedChanged } from "./store.js";
import { createSync } from "./sync.js";
import { detectPlatform, h, toast } from "./ui/dom.js";
import { createHome } from "./ui/home.js";
import { brandMark } from "./ui/install.js";
import { createOnboarding } from "./ui/onboarding.js";

const root = document.getElementById("app");
const platform = detectPlatform();

// iPhones launch a home-screen app at the address it was added from, which is how an
// invite survives installation. A manifest would override that address, so it is left out there.
if (!platform.isIOS) {
  document.head.append(h("link", { rel: "manifest", href: "manifest.webmanifest" }));
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  // Local development skips the offline cache unless asked for with ?sw.
  if (local && !new URLSearchParams(location.search).has("sw")) return;
  navigator.serviceWorker.register("sw.js").catch(() => {
    // Offline support is a bonus; the app works without it.
  });
}

function showSetupNeeded() {
  root.replaceChildren(h("main", { class: "onboard" },
    brandMark(),
    h("h1", { text: "Almost there" }),
    h("p", { class: "lede", text: "This copy of Water Pact isn't connected to its database yet. Add the project URL and publishable key to config.js, then reload." })));
}

function start() {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) {
    showSetupNeeded();
    return;
  }
  // Only a connected copy is worth keeping offline; caching an unconnected one would
  // leave phones stuck on the setup screen after the database details are added.
  registerServiceWorker();

  const store = createStore(loadSaved());
  let storageWarned = false;
  store.subscribe((state, prev) => {
    if (!persistedChanged(state, prev) || persist(state) || storageWarned) return;
    storageWarned = true;
    toast("This browser is blocking storage, so your log won't be remembered here.");
  });

  const api = createApi({ url: CONFIG.supabaseUrl, key: CONFIG.supabaseKey });
  const sync = createSync({ api, store, notify: toast });

  let joinCode = parseJoinHash(location.hash);
  let installPrompt = null;
  const ctx = Object.freeze({
    api, store, sync, platform,
    joinCode: () => joinCode,
    setJoinCode: (code) => { joinCode = code; },
    installPrompt: () => installPrompt,
    inviteUrl: (code) => `${location.origin}${location.pathname}#join=${code}`,
  });

  let screen = null;
  function route() {
    const wanted = store.get().identity ? "home" : "onboarding";
    if (!screen || screen.name !== wanted) {
      if (screen) screen.destroy();
      screen = wanted === "home" ? createHome(root, ctx) : createOnboarding(root, ctx);
      window.scrollTo(0, 0);
      return;
    }
    screen.update();
  }

  function warnIfOtherPact() {
    const { identity } = store.get();
    if (identity && joinCode && joinCode !== identity.code) {
      toast("You're already in a pact. Leave it in Settings to join another.");
    }
  }

  // After leaving (or losing) a pact, drop its invite from the address so the start screen shows.
  store.subscribe((state, prev) => {
    if (!prev.identity || state.identity) return;
    history.replaceState(null, "", location.pathname + location.search);
    joinCode = null;
  });
  store.subscribe(route);
  window.addEventListener("hashchange", () => {
    joinCode = parseJoinHash(location.hash);
    warnIfOtherPact();
    route();
  });
  // Coming back to the app: show the right date and pace at once, not at the next minute tick.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) route();
  });
  window.addEventListener("beforeinstallprompt", (evt) => {
    evt.preventDefault();
    installPrompt = evt;
    route();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    route();
  });

  route();
  warnIfOtherPact();
  sync.start();
}

start();
