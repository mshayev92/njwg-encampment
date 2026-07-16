/* ============================================================
   NJWG ENCAMPMENT — SERVICE WORKER
   Caches the app shell (HTML/CSS/JS) for OFFLINE use, but serves it
   NETWORK-FIRST when online (see the fetch handler) so a freshly
   deployed change shows up on the very next load instead of only after
   a second visit — the trap a cache-first shell falls into. The cached
   copy is the offline fallback, refreshed on every successful fetch.
   Does NOT cache Apps Script API responses — schedule/roster data
   always comes straight from the network.

   A cache-first/stale-while-revalidate version of this file was tried
   (to make page-to-page navigation feel instant) and reverted — across
   several rounds of fixes it kept surfacing new browser-specific
   navigation failures (redirected-response errors, only-if-cached
   speculative requests, atomic-install failures leaving devices stuck
   on old workers) that were hard to reproduce and verify outside the
   field. Network-first is the version known to work reliably; revisit
   the smoother-navigation idea separately if it's worth another attempt
   (e.g. an in-page prefetch-on-hover instead of changing the SW's
   navigation strategy).
   ============================================================ */

// Bumped to v12 to revert every device from the v7-v11 cache-first
// experiment back to network-first — changing this name forces every
// device to drop its old cached shell on activate instead of
// continuing to run any of the previous strategies.
const CACHE_NAME = "njwg-encampment-v12";

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
  "./pages/notes.html",
  "./pages/admin.html",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon.ico"
].map((path) => new URL(path, self.location.href).href);

self.addEventListener("install", (event) => {
  // Precache each shell asset INDEPENDENTLY, tolerating individual
  // failures — cache.addAll() is atomic, so a single missing/unreachable
  // URL would abort the WHOLE install, leaving the new worker never
  // activated and the device stuck running whatever the PREVIOUS
  // worker was. allSettled + individual cache.add() means one bad
  // asset is skipped, not fatal, so a new version always takes over.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
    )
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

// ---- Web Push -------------------------------------------------------------
// Shows a notification for a New Announcement / Black Flag change pushed
// from the Worker backend (see worker/src/webPush.js), even when the app
// isn't open. Clicking it focuses an existing tab on the target page or
// opens a new one.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "NJWG Encampment";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: new URL("./icons/icon-192.png", self.location.href).href,
    badge: new URL("./icons/icon-192.png", self.location.href).href,
    data: { url: data.url || "./" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawUrl = (event.notification.data && event.notification.data.url) || "./";
  const target = new URL(rawUrl, self.location.href).href;

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Prefer an already-open tab on the exact target page.
    for (const client of clientList) {
      if (client.url === target && "focus" in client) return client.focus();
    }
    // Otherwise reuse any open app window, navigating it to the target.
    for (const client of clientList) {
      if ("focus" in client && "navigate" in client) {
        await client.focus();
        return client.navigate(target);
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
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
