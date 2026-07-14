/* ============================================================
   NJWG ENCAMPMENT — SERVICE WORKER
   Caches the app shell (HTML/CSS/JS) for OFFLINE use, but serves it
   NETWORK-FIRST when online (see the fetch handler) so a freshly
   deployed change shows up on the very next load instead of only after
   a second visit — the trap a cache-first shell falls into. The cached
   copy is the offline fallback, refreshed on every successful fetch.
   Does NOT cache Apps Script API responses — schedule/roster data
   always comes straight from the network.
   ============================================================ */

// Bumped to v4 alongside the switch from cache-first to network-first
// for the app shell (see the fetch handler below) — changing this name
// forces every device to drop its old cached shell on activate instead
// of continuing to serve stale markup/CSS/JS.
const CACHE_NAME = "njwg-encampment-v4";

// Paths are relative to this file's own location (self.location), which
// is whatever folder the service worker is served from — the repo root
// on a custom domain, or "/repo-name/" on a GitHub Pages project site.
// This means service-worker.js MUST be registered from the site's own
// root (see README "Register the service worker"), not moved into a
// subfolder, or its scope won't cover the whole app.
const APP_SHELL = [
  "./",
  "./index.html",
  "./gate.html",
  "./manifest.json",
  "./css/tokens.css",
  "./css/app.css",
  "./js/config.js",
  "./js/api.js",
  "./js/auth.js",
  "./js/shell.js",
  "./pages/schedule.html",
  "./pages/roster.html",
  "./pages/inspections.html",
  "./pages/overview.html",
  "./pages/announcements.html",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon.ico"
].map((path) => new URL(path, self.location.href).href);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache calls to the Apps Script backend — always go to network.
  if (url.hostname.includes("script.google.com")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell: network-first, falling back to the cached copy offline.
  // Keeping this network-first (rather than cache-first) means a deploy
  // is picked up immediately when online — HTML and its matching JS/CSS
  // are always fetched together fresh — while the cache, refreshed on
  // every successful response, still serves the whole app offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
