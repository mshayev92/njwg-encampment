/* ============================================================
   NJWG ENCAMPMENT — SERVICE WORKER
   Caches the app shell (HTML/CSS/JS) for OFFLINE use, but serves it
   NETWORK-FIRST when online (see the fetch handler) so a freshly
   deployed change shows up on the very next load instead of only after
   a second visit — the trap a cache-first shell falls into. The cached
   copy is the offline fallback, refreshed on every successful fetch.
   Only SAME-ORIGIN GET requests (the app shell) are ever cached — the
   backend API (the Cloudflare Worker on a different origin), the weather
   service, and web fonts are cross-origin and pass straight through to
   the network, never cached. Caching API responses would both bloat the
   cache (each request URL carries the device + session tokens as query
   params, so every distinct token makes a new entry) and risk serving
   stale JSON the app's own read cache (js/api.js) doesn't expect.

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

// Bumped to v18: the fetch handler now revalidates subresources against the
// server (cache: "no-cache") so a freshly deployed css/app.css or js/shell.js
// reaches returning online users on the next load instead of being pinned by
// GitHub Pages' default HTTP max-age. Bumping the cache name also re-precaches
// the shell under the new version and evicts the old cache on activate.
const CACHE_NAME = "njwg-encampment-v18";

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
  "./offline.html",
  "./manifest.json",
  "./css/tokens.css",
  "./css/app.css",
  "./js/config.js",
  "./js/api.js",
  "./js/auth.js",
  "./js/shell.js",
  "./js/richtext.js",
  "./pages/schedule.html",
  "./pages/roster.html",
  "./pages/inspections.html",
  "./pages/overview.html",
  "./pages/announcements.html",
  "./pages/notes.html",
  "./pages/observations.html",
  "./pages/recommendations.html",
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
  const request = event.request;
  const url = new URL(request.url);

  // Only the same-origin app shell is cached. Everything else — the
  // backend API (the Cloudflare Worker, a different origin), the weather
  // service, web fonts, and any non-GET request — goes straight to the
  // network with default browser handling and is never cached. This is
  // what keeps auth-token-bearing API URLs, and stale API JSON, out of
  // the Cache Storage the app shell lives in.
  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return; // don't call respondWith — let the browser fetch it normally
  }

  // App shell: network-first, falling back to the cached copy offline.
  // Keeping this network-first (rather than cache-first) means a deploy
  // is picked up immediately when online — HTML and its matching JS/CSS
  // are always fetched together fresh — while the cache, refreshed on
  // every successful response, still serves the whole app offline.
  const isNavigation = request.mode === "navigate";

  // For SUBRESOURCES (css/app.css, js/shell.js, icons) revalidate against the
  // server instead of letting the browser's HTTP cache answer from a stale
  // copy — GitHub Pages serves these with a default max-age, so a returning
  // online user could otherwise run a freshly deployed CSS/JS's OLD bytes for
  // that whole window even though this handler is "network-first". `no-cache`
  // (conditional, not `no-store`) means an UNCHANGED asset still 304s cheaply;
  // only genuinely-changed bytes are re-downloaded. Navigations are left as-is
  // (a "navigate"-mode Request can't be safely reconstructed, and the browser
  // already revalidates top-level HTML).
  const networkRequest = isNavigation ? request : new Request(request, { cache: "no-cache" });

  event.respondWith(
    fetch(networkRequest)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(async () => {
        // ignoreSearch: true only for page navigations — a page URL isn't
        // expected to carry a cache-relevant query string in this app, so a
        // stray one (e.g. a future ?returnTo=... variant) shouldn't cause an
        // otherwise-precached page to miss its cached copy while offline.
        // JS/CSS/icon requests keep the default exact match.
        const cached = await caches.match(request, isNavigation ? { ignoreSearch: true } : undefined);
        if (cached) return cached;
        // No cached copy of this exact navigation (a typo'd URL, or a page
        // added to the app after this device's cache was last populated) —
        // show the themed offline fallback instead of the browser's native
        // "no internet" error page. Only for navigations; a missing CSS/JS/
        // icon request just fails normally (the page already handles a
        // missing asset far better than replacing it with a whole HTML page).
        if (isNavigation) return caches.match("./offline.html");
        return Response.error();
      })
  );
});
