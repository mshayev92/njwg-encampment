/* ============================================================
   NJWG ENCAMPMENT — API CLIENT
   Talks to the Google Apps Script Web App deployed in front of
   the private Google Sheet. No API key is used or needed — the
   Apps Script runs "as me" (the sheet owner) under a public /exec
   URL.

   IMPORTANT — because the site is hosted publicly (GitHub Pages),
   that /exec URL is not secret: anyone can view source and see it,
   and anyone can call it directly. So neither a passphrase nor a
   position is trusted as ongoing authentication — each is exchanged
   ONCE for a signed, expiring token (device token / session token,
   see js/auth.js), and this client attaches BOTH tokens to every
   read/write. The Apps Script backend verifies both tokens'
   signatures and expiry server-side on every call — see
   apps-script/Code.gs.

   PERFORMANCE MODEL (stale-while-revalidate + optimistic writes):
   Every read is cached in memory (cleared on full page reload, kept
   across in-app navigation isn't possible since this is a static
   multi-page app, not an SPA — so the cache really only helps within
   a single page's lifetime: an initial load plus any manual Refresh).
   The FIRST read for a sheet on a given page still has to wait on the
   network. What this buys you: getSheet() no longer needs to be
   awaited before showing SOMETHING — Api.getSheetCached() returns
   cached data synchronously if present, so a page can render
   instantly on second load, revalidate, and only re-render if the
   data actually changed. See Shell.mountList() in js/shell.js, which
   wraps this pattern for page authors so they don't reimplement it.

   Writes are optimistic: Api.writeRow()/deleteRow() return
   IMMEDIATELY (a resolved Promise) once the request is queued, rather
   than waiting for the network round-trip. The actual network call
   happens in the background; Api.onSyncStatusChange() reports
   queued -> syncing -> synced (or -> error, with automatic retry) so
   the header's sync indicator can show honest state without blocking
   the person's next click. Callers that truly need to know the
   server's result (e.g. to catch a permission error and roll back a
   local change) can pass { optimistic: false } to await the real
   round-trip instead — used sparingly, since that's the slow path
   this whole rework exists to avoid.
   ============================================================ */

const Api = (() => {
  const BASE_URL = window.APP_CONFIG.APPS_SCRIPT_URL;

  function getSessionToken() {
    return (typeof Auth !== "undefined" && Auth.getToken) ? Auth.getToken() : null;
  }

  function getDeviceToken() {
    return (typeof Auth !== "undefined" && Auth.getDeviceToken) ? Auth.getDeviceToken() : null;
  }

  /**
   * Internal fetch wrapper.
   * GET requests use query params. POST requests send a JSON body as
   * text/plain (avoids CORS preflight against Apps Script Web Apps).
   *
   * requireDevice/requireSession control which tokens are attached and
   * required for this particular call:
   *   - deviceLogin:    neither (that's the call that ISSUES the device token)
   *   - listPositions:  device token only (device already unlocked, no position chosen yet)
   *   - login:          device token only (device already unlocked, no session yet)
   *   - read/write:     both device token and session token
   */
  async function request(action, { method = "GET", params = {}, body = null, requireDevice = true, requireSession = true } = {}) {
    if (!BASE_URL || BASE_URL.includes("PASTE_YOUR_DEPLOYMENT_ID_HERE")) {
      throw new Error(
        "Apps Script URL is not configured yet. Set APPS_SCRIPT_URL in js/config.js."
      );
    }

    const deviceToken = requireDevice ? getDeviceToken() : null;
    if (requireDevice && !deviceToken) {
      throw new Error("Device not unlocked. Please enter the passphrase again.");
    }

    const sessionToken = requireSession ? getSessionToken() : null;
    if (requireSession && !sessionToken) {
      throw new Error("Not signed in. Please sign in again.");
    }

    const tokenParams = {
      ...(deviceToken ? { deviceToken } : {}),
      ...(sessionToken ? { token: sessionToken } : {})
    };

    let url = `${BASE_URL}?action=${encodeURIComponent(action)}`;
    for (const [key, value] of Object.entries({ ...params, ...tokenParams })) {
      url += `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }

    const options = { method };

    if (method === "POST") {
      options.headers = { "Content-Type": "text/plain;charset=utf-8" };
      options.body = JSON.stringify({ action, ...body, ...tokenParams });
    }

    let response;
    try {
      response = await fetch(url, options);
    } catch (networkErr) {
      throw new Error("Network error reaching the server. Check your connection and try again.");
    }

    if (!response.ok) {
      throw new Error(`Server responded with status ${response.status}.`);
    }

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      throw new Error("Server returned an unreadable response.");
    }

    if (data && data.ok === false) {
      const message = data.error || "Request failed.";
      handleAuthFailure_(message);
      throw new Error(message);
    }

    return data;
  }

  /**
   * If the backend rejected a device or session token, clear the
   * relevant local state and bounce to the right gate — device errors
   * go to the passphrase screen, session errors go to the position
   * picker — rather than leaving the user stuck on a silent failure.
   */
  function handleAuthFailure_(message) {
    if (typeof Auth === "undefined") return;

    const isDeviceError = /device|passphrase/i.test(message);
    const isSessionError = /session token|invalid token|malformed token/i.test(message) && !isDeviceError;

    if (isDeviceError) {
      Auth.clearDeviceAuth();
      Auth.clearSession();
      // A rejected device token means this device is logging out at the
      // deepest level — don't leave any position's cached reads behind
      // for whoever unlocks the device next.
      clearCacheInternal_();
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `${window.APP_BASE_PATH}gate.html?returnTo=${returnTo}`;
    } else if (isSessionError) {
      Auth.clearSession();
      clearCacheInternal_();
      const returnTo = encodeURIComponent(window.location.pathname);
      window.location.href = `${window.APP_BASE_PATH}index.html?returnTo=${returnTo}`;
    }
  }

  // ---- Read cache (stale-while-revalidate, persisted across page loads) --
  //
  // This is a static multi-page app — every navigation is a full page
  // load, which would otherwise wipe an in-memory-only cache and force
  // every single click to wait on the network again. To fix that, the
  // cache is mirrored into localStorage and re-hydrated into memory the
  // instant this script loads on each new page, so a page can render
  // instantly from whatever the LAST page fetched, before this page's
  // own network call even starts. Every render from cache still kicks
  // off a background revalidation (see getSheetCached below), so data
  // is never allowed to go stale for long.

  const CACHE_STORAGE_PREFIX = "njwg_cache_v1_";

  // sheetName -> { data, fetchedAt }
  const cache = new Map();
  // sheetName -> Set<callback> to notify when a background refetch
  // for that sheet resolves with (possibly) fresher data.
  const subscribers = new Map();
  // sheetName -> in-flight Promise, so concurrent calls for the same
  // sheet share one network request instead of firing duplicates.
  const inFlight = new Map();

  function cacheKey(sheetName, extraParams) {
    const suffix = Object.keys(extraParams || {}).length ? JSON.stringify(extraParams) : "";
    return sheetName + suffix;
  }

  function persistToStorage_(key, entry) {
    try {
      localStorage.setItem(CACHE_STORAGE_PREFIX + key, JSON.stringify(entry));
    } catch (e) {
      // Storage full or unavailable (private browsing, quota exceeded) —
      // the in-memory cache still works for the rest of this page's
      // life, it just won't survive the next navigation. Not worth
      // surfacing to the user over.
    }
  }

  function clearCacheInternal_() {
    cache.clear();
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(CACHE_STORAGE_PREFIX) === 0) keysToRemove.push(k);
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* ignore */ }
  }

  function hydrateFromStorage_() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const storageKey = localStorage.key(i);
        if (!storageKey || storageKey.indexOf(CACHE_STORAGE_PREFIX) !== 0) continue;
        const raw = localStorage.getItem(storageKey);
        if (!raw) continue;
        const entry = JSON.parse(raw);
        if (entry && "data" in entry) {
          cache.set(storageKey.slice(CACHE_STORAGE_PREFIX.length), entry);
        }
      }
    } catch (e) {
      // Corrupt entry or storage disabled — worst case this page makes
      // a real network call instead of rendering from cache, same as
      // before this feature existed.
    }
  }

  hydrateFromStorage_();

  function notifySubscribers_(key, data) {
    const subs = subscribers.get(key);
    if (subs) subs.forEach((cb) => { try { cb(data); } catch (e) { /* one bad subscriber shouldn't break others */ } });
  }

  async function fetchSheet_(sheetName, extraParams) {
    const key = cacheKey(sheetName, extraParams);
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = request("read", { params: { sheet: sheetName, ...extraParams } })
      .then((data) => {
        const entry = { data, fetchedAt: Date.now() };
        cache.set(key, entry);
        persistToStorage_(key, entry);
        inFlight.delete(key);
        notifySubscribers_(key, data);
        return data;
      })
      .catch((err) => {
        inFlight.delete(key);
        throw err;
      });

    inFlight.set(key, promise);
    return promise;
  }

  // ---- Sync status (for the header's sync indicator) -------------------

  // "idle" | "syncing" | "synced" | "error"
  let syncStatus = "idle";
  let pendingWrites = 0;
  const syncListeners = new Set();

  function setSyncStatus_(status) {
    syncStatus = status;
    syncListeners.forEach((cb) => { try { cb(status, pendingWrites); } catch (e) { /* ignore */ } });
    // "synced" is a momentary confirmation, not a resting state — fall
    // back to idle shortly after so the indicator doesn't sit lit up
    // forever after the last write of a session.
    if (status === "synced") {
      setTimeout(() => {
        if (pendingWrites === 0 && syncStatus === "synced") setSyncStatus_("idle");
      }, 2500);
    }
  }

  /**
   * Runs an already-queued write/delete against the network, updating
   * sync status around it. Retries once on a plain network failure
   * (not on a server-rejected write, e.g. a permission error, which
   * won't succeed on retry) before reporting "error".
   */
  async function performWrite_(action, body) {
    pendingWrites++;
    setSyncStatus_("syncing");

    const attempt = () => request(action, { method: "POST", body });

    try {
      const result = await attempt();
      pendingWrites = Math.max(0, pendingWrites - 1);
      if (pendingWrites === 0) setSyncStatus_("synced");
      return result;
    } catch (err) {
      const isNetworkError = /network error/i.test(err.message);
      if (isNetworkError) {
        try {
          const result = await attempt();
          pendingWrites = Math.max(0, pendingWrites - 1);
          if (pendingWrites === 0) setSyncStatus_("synced");
          return result;
        } catch (retryErr) {
          pendingWrites = Math.max(0, pendingWrites - 1);
          setSyncStatus_("error");
          throw retryErr;
        }
      }
      pendingWrites = Math.max(0, pendingWrites - 1);
      setSyncStatus_("error");
      throw err;
    }
  }

  return {
    /**
     * Fetch all rows from a named sheet tab. Always hits the network
     * and returns fresh data — use this when you specifically need to
     * KNOW the call happened (e.g. right after a write, or on a manual
     * Refresh). For the fast instant-then-revalidate pattern used on
     * normal page load, use getSheetCached() instead.
     */
    getSheet(sheetName, extraParams = {}) {
      return fetchSheet_(sheetName, extraParams);
    },

    /**
     * Stale-while-revalidate read. Returns { data, isFromCache }
     * SYNCHRONOUSLY if a cached copy exists (data may be a moment
     * stale), while ALSO kicking off a background refetch. Pass
     * onFresh(data) to be notified if/when the background refetch
     * resolves with data — call it to re-render only when something
     * actually changed. If nothing is cached yet, data is null and
     * isFromCache is false; await the returned `ready` promise (or
     * just use onFresh) to get the first real result.
     */
    getSheetCached(sheetName, onFresh, extraParams = {}) {
      const key = cacheKey(sheetName, extraParams);
      const cached = cache.get(key);

      if (onFresh) {
        if (!subscribers.has(key)) subscribers.set(key, new Set());
        subscribers.get(key).add(onFresh);
      }

      const ready = fetchSheet_(sheetName, extraParams);

      if (cached) {
        return { data: cached.data, isFromCache: true, ready };
      }
      return { data: null, isFromCache: false, ready };
    },

    /** Stop receiving background-refresh notifications for a sheet — call on page teardown if needed. */
    unsubscribe(sheetName, onFresh, extraParams = {}) {
      const key = cacheKey(sheetName, extraParams);
      const subs = subscribers.get(key);
      if (subs) subs.delete(onFresh);
    },

    /**
     * Clears the read cache and forces a fresh fetch of every sheet
     * currently cached, notifying subscribers as each comes back. This
     * is what the dedicated Refresh button calls — a real, visible,
     * "go get everything again" action, distinct from the instant
     * cached-render every page does automatically on load.
     */
    async hardRefresh() {
      // Deliberately does NOT clear the cache. getSheetCached() always
      // triggers a real network fetch regardless of what's cached, so
      // the page's own load() (called right after this by Shell's
      // hardRefresh) already guarantees fresh data lands — wiping the
      // cache first used to just blank the page back to its "Loading…"
      // spinner for a moment while that fetch was in flight, stacked on
      // top of the header's own refresh spinner, which looked broken
      // (two spinners) and made a normal load fail to show ANYTHING
      // if the refetch hit a rate limit. Keeping old data on screen
      // until the fresh data actually arrives is strictly better.
      return Array.from(cache.keys());
    },

    /**
     * Fire-and-forget background fetch for a list of sheet names not
     * necessarily used by THIS page — called once per page load (see
     * Shell.init) so that by the time someone navigates to another
     * page, its data is already warm in the persisted cache and renders
     * instantly instead of waiting on the network. Skips a sheet
     * entirely if it was already fetched within maxAgeMs, so clicking
     * around quickly doesn't re-hit the backend on every single load.
     * Default is deliberately generous (2 minutes) — the backend caps
     * reads at 30 requests/minute per session, and warming 5 sheets on
     * every single page load/navigation adds up fast otherwise.
     */
    warmCache(sheetNames, { maxAgeMs = 120000 } = {}) {
      (sheetNames || []).forEach((name) => {
        const key = cacheKey(name, {});
        const cached = cache.get(key);
        if (cached && Date.now() - cached.fetchedAt < maxAgeMs) return;
        fetchSheet_(name, {}).catch(() => { /* best-effort — the page that actually needs this sheet will surface its own error */ });
      });
    },

    /**
     * Wipes both the in-memory and persisted cache entirely. Call on
     * logout — otherwise the NEXT person to sign in on a shared device
     * would instantly render the PREVIOUS position's cached Roster/
     * Schedule/etc. before their own session's read even lands.
     */
    clearCache: clearCacheInternal_,

    /**
     * Append or update a row. rowData is a plain object of column:value
     * pairs. Pass matchColumn for a single-column key (Roster, Schedule,
     * Announcements-style), or matchColumns (array) for a composite key
     * — e.g. UniformInspections uses ["StudentCapId", "Date"] so a new
     * DAY appends a new row instead of overwriting history, while a
     * second save on the same day still updates in place.
     *
     * OPTIMISTIC BY DEFAULT: resolves immediately once queued; the
     * actual write happens in the background (tracked via
     * onSyncStatusChange). Pass { optimistic: false } to instead await
     * the real server round-trip — e.g. when the caller needs to react
     * to a permission error before updating its own UI.
     */
    writeRow(sheetName, rowData, { matchColumn = null, matchColumns = null, optimistic = true } = {}) {
      const body = { sheet: sheetName, row: rowData, matchColumn, matchColumns };
      if (!optimistic) return performWrite_("write", body);
      // Fire the real request in the background (errors surface via
      // onSyncStatusChange -> "error", not a rejected promise here) and
      // resolve immediately so the caller can update its own UI without
      // waiting on the network round-trip.
      performWrite_("write", body).catch(() => { /* status already reported via setSyncStatus_ */ });
      return Promise.resolve({ ok: true, action: "queued", row: rowData });
    },

    /**
     * Deletes a row matched by matchColumn/matchColumns against
     * matchValues. Same optimistic-by-default behavior as writeRow.
     */
    deleteRow(sheetName, matchValues, { matchColumn = null, matchColumns = null, optimistic = true } = {}) {
      const body = { sheet: sheetName, matchValues, matchColumn, matchColumns };
      if (!optimistic) return performWrite_("delete", body);
      performWrite_("delete", body).catch(() => { /* status already reported via setSyncStatus_ */ });
      return Promise.resolve({ ok: true, action: "queued" });
    },

    /** Subscribe to sync status changes: cb(status, pendingCount). Returns an unsubscribe function. */
    onSyncStatusChange(cb) {
      syncListeners.add(cb);
      cb(syncStatus, pendingWrites);
      return () => syncListeners.delete(cb);
    },

    getSyncStatus() {
      return { status: syncStatus, pending: pendingWrites };
    },

    /**
     * LAYER 1 — exchange the shared passphrase for a device token.
     * Requires neither existing token (this call issues the first one).
     */
    deviceLogin(passphrase, deviceType) {
      return request("deviceLogin", {
        method: "POST",
        body: { passphrase, deviceType },
        requireDevice: false,
        requireSession: false
      });
    },

    /**
     * Fetches the list of valid position names (e.g. "Alpha Flight",
     * "CCT") from StaffAccess, to populate the login dropdown. Requires
     * the device to already be unlocked but no session yet. Returns
     * only position names — never Role, Pages, or anything else.
     */
    listPositions() {
      return request("listPositions", {
        requireDevice: true,
        requireSession: false
      });
    },

    /**
     * LAYER 2 — exchange a chosen position (plus password, for
     * password-protected positions like CCT/Administrator) for a
     * per-position session token. Requires the device token (already
     * unlocked) but no session yet.
     */
    login(position, password) {
      return request("login", {
        method: "POST",
        body: { position, password },
        requireDevice: true,
        requireSession: false
      });
    }
  };
})();
