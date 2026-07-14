/* ============================================================
   NJWG ENCAMPMENT — SERVICE WORKER
   Caches the app shell (HTML/CSS/JS) for offline use.
   Does NOT cache Apps Script API responses — schedule/roster
   data should always come from the network when available.
   ============================================================ */

// Bumped for the v2 redesign (new palette, icons, custom chrome) —
// changing this forces every device to drop its old cached shell
// instead of continuing to serve stale navy/gold assets after deploy.
const CACHE_NAME = "njwg-encampment-v2";

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

  // App shell: cache-first, falling back to network, then updating cache.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});