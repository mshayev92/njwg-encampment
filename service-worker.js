/* ============================================================
   NJWG ENCAMPMENT — SERVICE WORKER
   Caches the app shell (HTML/CSS/JS) and serves it STALE-WHILE-
   REVALIDATE (see the fetch handler): an instant response from cache
   when one exists, with a network fetch kicked off in parallel to
   refresh the cache for the NEXT navigation. This app is a static
   multi-page site — every nav-rail click is a full browser navigation
   to a new HTML document — so a network-first shell meant every single
   page-to-page click paused on a round trip before anything painted,
   even though the sheet data itself was already rendering instantly
   from js/api.js's own cache. Cache-first removes that pause; a fresh
   deploy still shows up (one navigation later than before, instead of
   immediately), which is a fair trade for every click no longer
   blocking on the network.
   Does NOT cache Apps Script API responses — schedule/roster data
   always comes straight from the network.
   ============================================================ */

// Bumped to v8 to move every device off the v7 fetch handler, which
// intercepted cross-origin/non-GET requests it shouldn't have and
// could surface a broken "page might be down" error (see the fetch
// handler below) — changing this name forces every device to drop its
// old cached shell on activate instead of continuing to run the buggy
// handler against a stale cache.
const CACHE_NAME = "njwg-encampment-v8";

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

  // Only intern the app's OWN same-origin GET requests (the app shell).
  // Everything else — the Apps Script backend, the weather API a page
  // calls directly (see pages/overview.html), Google Fonts, any POST —
  // is left completely untouched by returning without calling
  // respondWith(), which tells the browser to handle it exactly as if
  // there were no service worker at all.
  //
  // This used to be a single hostname exclusion (script.google.com
  // only), so every OTHER cross-origin fetch on the page — notably the
  // direct-to-api.open-meteo.com weather call — was still being routed
  // through the cache logic below. cache.match()/cache.put() throw for
  // non-GET requests, and a failed cross-origin fetch with nothing yet
  // cached had no valid fallback, so the promise passed to
  // respondWith() could resolve to `undefined` — which Chrome shows as
  // a broken "this page might be temporarily down" error for the WHOLE
  // navigation, not just the one failed subrequest.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // App shell: stale-while-revalidate. Serve the cached copy instantly
  // if we have one (no network wait between clicking a nav link and the
  // next page painting), while a background fetch refreshes the cache
  // for next time. First-ever load (nothing cached yet) still waits on
  // the network, same as before.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);

      // Kicked off either way: to serve when nothing's cached yet, or
      // just to refresh the cache quietly when something already is.
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone()).catch(() => {});
          return response;
        })
        .catch(() => null);

      if (cached) return cached;

      // Never resolve to undefined here — that's what turns a normal
      // "network unreachable and nothing cached yet" failure into the
      // broken-page error described above. A synthesized response
      // keeps the browser's own offline/error handling in charge.
      return (await network) || new Response("Offline and not yet cached.", { status: 503, statusText: "Offline" });
    })
  );
});
