/* ============================================================
   NJWG ENCAMPMENT — API CLIENT
   Talks to the Cloudflare Worker backend (worker/src/) deployed in
   front of the private Google Sheet, which reaches the Sheet via the
   Sheets API using a service account. The Worker URL is in
   js/config.js (APPS_SCRIPT_URL — name kept for historical reasons).

   IMPORTANT — because the site is hosted publicly (GitHub Pages),
   that Worker URL is not secret: anyone can view source and see it,
   and anyone can call it directly. So neither a passphrase nor a
   position is trusted as ongoing authentication — each is exchanged
   ONCE for a signed, expiring token (device token / session token,
   see js/auth.js), and this client attaches BOTH tokens to every
   read/write. The Worker verifies both tokens' signatures and expiry
   server-side on every call — see worker/src/auth.js.

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
   data actually changed. See Shell.mountSheet() in js/shell.js, which
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

  // Apps Script web apps occasionally stall (cold starts, transient
  // Google-side slowness) instead of erroring outright. Without a
  // client-side timeout, a stalled fetch() never settles — and since
  // fetchSheet_ below dedupes concurrent reads of the same sheet through
  // a single in-flight Promise, one stuck request silently blocks every
  // future read/refresh of that sheet too, with no error ever shown.
  // This is the "sometimes Refresh just does nothing" symptom. Aborting
  // after REQUEST_TIMEOUT_MS guarantees the promise always eventually
  // settles (rejects), which clears it out of inFlight/hardRefreshInFlight_
  // and lets the next click retry cleanly.
  const REQUEST_TIMEOUT_MS = 15000;

  // Client-side freshness window. A read satisfied within this many ms is
  // served straight from the (in-memory + localStorage) cache with NO
  // network request. This is the main fix for the "Too many requests"
  // errors: because this is a static MULTI-PAGE app, every navigation
  // reloads the page and every page calls getSheetCached() for the
  // sheets it shows — which previously fired a fresh fetch EVERY time,
  // even for a sheet another page fetched two seconds earlier. Those
  // redundant fetches still counted against the backend's per-token
  // rate limit (Code.gs RATE_LIMIT_PER_MINUTE), even though the backend
  // was already serving them from its own 20s cache. Gating on freshness
  // here means rapid page-to-page navigation, repeated getSheetCached()
  // calls, and the header's background pollers stop re-hitting the
  // backend for data that's only seconds old. Aligned with the backend's
  // READ_CACHE_TTL_SECONDS — within this window a refetch would return
  // byte-identical data anyway. Explicit refreshes (getSheet() and the
  // Refresh button) bypass this and always force a live fetch.
  const FRESH_TTL_MS = 20000;

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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    options.signal = controller.signal;

    let response;
    try {
      response = await fetch(url, options);
    } catch (networkErr) {
      if (networkErr.name === "AbortError") {
        throw new Error("Request timed out. Check your connection and try again.");
      }
      throw new Error("Network error reaching the server. Check your connection and try again.");
    } finally {
      clearTimeout(timeoutId);
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

  /**
   * Marks every cached entry for a sheet as stale (fetchedAt = 0) so the
   * NEXT read revalidates against the network instead of being served
   * from the freshness window. Called after a write/delete to that sheet
   * (so nobody reads their own pre-write data back for up to FRESH_TTL_MS)
   * and by hardRefresh() (so the Refresh button always re-fetches). The
   * stale data is deliberately KEPT in the cache, not removed, so pages
   * can still render it instantly while the revalidation is in flight.
   */
  function markSheetStale_(sheetName) {
    cache.forEach((entry, key) => {
      if (key === sheetName || key.indexOf(sheetName) === 0) {
        entry.fetchedAt = 0;
        persistToStorage_(key, entry);
      }
    });
  }

  function normalizeCell_(v) {
    return v === undefined || v === null ? "" : String(v);
  }

  /**
   * True only when an UPDATE write (one carrying match columns) would store
   * a row byte-identical to what's already in the cached full-sheet read —
   * i.e. the write is a genuine no-op and can be skipped, sparing a server
   * round-trip AND the KV invalidate + repopulation it would trigger. This
   * is the client half of "never write unless the data actually changed".
   *
   * The bias is entirely toward writing: it returns true ONLY when it can
   * positively identify exactly one matching cached row whose every column
   * already equals what the write would set. Anything uncertain — no cache
   * for the sheet, no match (a real insert), an ambiguous multi-match, or
   * an append (no match columns at all) — returns false so the write still
   * happens. A value that merely stringifies the same IS the same value, so
   * this can never hide a real change; at worst it misses skipping a
   * no-op (e.g. a boolean re-read as "TRUE" vs "true"), which is harmless.
   *
   * Note the server's setRow REPLACES the whole row: a column present on
   * the existing row but omitted from rowData would be blanked, so the
   * comparison spans the UNION of both column sets, treating "missing" as
   * the empty string exactly as the server would write it.
   */
  function updateWouldBeNoop_(sheetName, rowData, matchColumns) {
    if (!Array.isArray(matchColumns) || !matchColumns.length) return false;
    const entry = cache.get(cacheKey(sheetName, {}));
    const rows = entry && entry.data && entry.data.rows;
    if (!Array.isArray(rows) || !rows.length) return false;

    // Locate the target row the SAME way the server does — trimmed,
    // case-insensitive equality on every match column (see
    // findMatchingRowNumber in worker/src/index.js).
    const keyOf = (row) => matchColumns.map((c) => normalizeCell_(row[c]).trim().toLowerCase()).join(" ");
    const targetKey = keyOf(rowData);
    const matches = rows.filter((r) => keyOf(r) === targetKey);
    if (matches.length !== 1) return false;
    const existing = matches[0];

    const keys = new Set([...Object.keys(existing), ...Object.keys(rowData)]);
    for (const k of keys) {
      if (normalizeCell_(existing[k]) !== normalizeCell_(rowData[k])) return false;
    }
    return true;
  }

  async function fetchSheet_(sheetName, extraParams, { force = false } = {}) {
    const key = cacheKey(sheetName, extraParams);

    // Freshness gate: if we fetched this sheet within FRESH_TTL_MS and the
    // caller isn't forcing a live read, serve the cached copy without a
    // network round-trip. This is what keeps navigation and repeated
    // reads from burning through the backend's rate limit.
    if (!force) {
      const fresh = cache.get(key);
      if (fresh && (Date.now() - fresh.fetchedAt) < FRESH_TTL_MS) {
        return fresh.data;
      }
    }

    if (inFlight.has(key)) return inFlight.get(key);

    const promise = request("read", { params: { sheet: sheetName, ...extraParams } })
      .then((data) => {
        // Skip notifying subscribers if this revalidation came back
        // identical to what's already cached (the common case, since a
        // page usually renders from cache and kicks off this refetch in
        // the same breath). Without this check, every background
        // revalidation — even a no-op one — fires onFresh again a moment
        // after the initial cached render, causing pages that call
        // Shell.animateIn() in their render function to replay the
        // entrance animation for content that didn't actually change.
        const previous = cache.get(key);
        const changed = !previous || JSON.stringify(previous.data) !== JSON.stringify(data);

        const entry = { data, fetchedAt: Date.now() };
        cache.set(key, entry);
        persistToStorage_(key, entry);
        inFlight.delete(key);
        if (changed) notifySubscribers_(key, data);
        return data;
      })
      .catch((err) => {
        inFlight.delete(key);
        throw err;
      });

    inFlight.set(key, promise);
    return promise;
  }

  /**
   * Warms several sheets in ONE request (action=batchRead) instead of one
   * read per sheet — this is the whole point of the batch endpoint. It
   * populates the same in-memory + persisted cache a normal read fills,
   * and notifies each sheet's subscribers when its data actually changed,
   * so the header bell / any open page picks up fresher data from the warm
   * too. Best-effort: a failure just leaves the cache as-is, and the page
   * that actually needs a sheet still issues its own read.
   *
   * Registers each requested name into the SAME `inFlight` map fetchSheet_
   * checks, so a page's own action=read for one of these sheets — fired
   * concurrently with this batch, e.g. right as a page loads while
   * warmCache is also warming it — shares this one in-flight batchRead
   * instead of firing a duplicate request. Without this, warmCache's own
   * inFlight check (see Api.warmCache) only ever caught the reverse case
   * (skip a sheet a page is already fetching); a page's read starting
   * AFTER this batch was already in flight had no way to know and would
   * fire its own redundant action=read for the same sheet.
   */
  function batchFetchSheets_(sheetNames) {
    if (!sheetNames.length) return Promise.resolve();

    // Defensive de-dupe against whatever's already in flight (normally
    // empty here — callers like Api.warmCache already filter these out —
    // but keeps this function correct if ever called with an overlapping
    // set directly).
    const names = sheetNames.filter((name) => !inFlight.has(cacheKey(name, {})));
    if (!names.length) return Promise.resolve();

    const promise = request("batchRead", { params: { sheets: names.join(",") } })
      .then((data) => {
        const sheets = (data && data.sheets) || {};
        const result = {};
        names.forEach((name) => {
          const key = cacheKey(name, {});
          // Store the SAME shape a read caches ({ ok, rows }) so the change
          // detection here — and every caller reading .rows — treats a
          // warmed sheet identically to an individually-read one (a shape
          // mismatch would make every warm look "changed" and re-fire
          // subscribers).
          const rowsData = { ok: true, rows: (sheets[name] && sheets[name].rows) || [] };
          const previous = cache.get(key);
          const changed = !previous || JSON.stringify(previous.data) !== JSON.stringify(rowsData);
          const entry = { data: rowsData, fetchedAt: Date.now() };
          cache.set(key, entry);
          persistToStorage_(key, entry);
          inFlight.delete(key);
          if (changed) notifySubscribers_(key, rowsData);
          result[name] = rowsData;
        });
        return result;
      })
      .catch((err) => {
        names.forEach((name) => inFlight.delete(cacheKey(name, {})));
        throw err;
      });

    // Each sheet's inFlight entry resolves to THAT sheet's own data (the
    // same shape fetchSheet_'s inFlight promise resolves to), so a
    // concurrent fetchSheet_ call returning this promise behaves exactly
    // like an ordinary individual read to its caller.
    names.forEach((name) => {
      inFlight.set(cacheKey(name, {}), promise.then((result) => result[name]));
    });

    return promise;
  }

  // ---- Sync status (for the header's sync indicator) -------------------

  // "idle" | "syncing" | "synced" | "error"
  let syncStatus = "idle";
  let pendingWrites = 0;
  const syncListeners = new Set();
  // Fired once per write/delete that lands in the outbox — separate from
  // syncListeners because "status is now syncing" doesn't distinguish a
  // brand-new item being queued from the outbox simply still draining;
  // Shell uses this to show a one-time "you're offline, this will sync
  // later" toast right when it actually happens (see onOutboxEnqueue).
  const outboxListeners = new Set();

  // Durable outbox for writes that couldn't reach the server (offline /
  // network error). Persisted to localStorage so a queued write survives
  // a page navigation or the app being closed, and replayed when
  // connectivity returns — see flushOutbox_ below. Loaded up front so its
  // length is reflected in the sync indicator's pending count immediately.
  const OUTBOX_STORAGE_KEY = "njwg_outbox_v1";
  let outbox = loadOutbox_();
  // If writes were left queued from a previous (offline) session, reflect
  // that as pending from the start rather than a misleading "Synced".
  if (outbox.length) syncStatus = "syncing";

  function loadOutbox_() {
    try {
      const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveOutbox_() {
    try { localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(outbox)); } catch (e) { /* quota/unavailable */ }
  }

  /** Reported pending = writes in flight now + writes waiting in the outbox. */
  function totalPending_() {
    return pendingWrites + outbox.length;
  }

  function setSyncStatus_(status) {
    syncStatus = status;
    syncListeners.forEach((cb) => { try { cb(status, totalPending_()); } catch (e) { /* ignore */ } });
    // "synced" is a momentary confirmation, not a resting state — fall
    // back to idle shortly after so the indicator doesn't sit lit up
    // forever after the last write of a session.
    if (status === "synced") {
      setTimeout(() => {
        if (totalPending_() === 0 && syncStatus === "synced") setSyncStatus_("idle");
      }, 2500);
    }
  }

  function isNetworkError_(err) {
    return err && /network error|timed out/i.test(err.message || "");
  }

  /** Queue a write that couldn't reach the server, to replay later. */
  function enqueueOutbox_(action, body) {
    outbox.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action,
      body,
      queuedAt: Date.now()
    });
    saveOutbox_();
    // There's pending work again — reflect it as syncing/pending rather
    // than leaving the indicator stuck on the transient "error" that the
    // failed immediate attempt just set.
    setSyncStatus_("syncing");
    outboxListeners.forEach((cb) => { try { cb(action, body); } catch (e) { /* one bad listener shouldn't break others */ } });
  }

  let flushingOutbox_ = false;

  /**
   * Replays queued writes in order. Stops (keeping the rest) the moment
   * another network error happens — we're still offline/unreachable, so
   * try again on the next trigger (reconnect / page load / visibility).
   * A write the server actively REJECTS (permission, validation, expired
   * token) can never succeed on replay, so it's dropped and surfaced,
   * rather than blocking the queue forever. Safe to call anytime; it
   * no-ops if empty, already running, or the browser reports offline.
   */
  async function flushOutbox_() {
    if (flushingOutbox_ || !outbox.length) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;

    flushingOutbox_ = true;
    setSyncStatus_("syncing");
    try {
      while (outbox.length) {
        const item = outbox[0];
        try {
          await request(item.action, { method: "POST", body: item.body });
          // Landed — the sheet's cached rows may now be behind the server.
          if (item.body && item.body.sheet) markSheetStale_(item.body.sheet);
          outbox.shift();
          saveOutbox_();
          setSyncStatus_("syncing"); // refresh pending count as it drains
        } catch (err) {
          if (isNetworkError_(err)) break; // still offline — retry later
          // Permanent rejection: drop it so it can't wedge the queue.
          outbox.shift();
          saveOutbox_();
          setSyncStatus_("error");
        }
      }
    } finally {
      flushingOutbox_ = false;
      if (totalPending_() === 0 && syncStatus !== "error") setSyncStatus_("synced");
    }
  }

  // Retry the outbox as soon as the browser regains connectivity.
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => flushOutbox_());
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
      return fetchSheet_(sheetName, extraParams, { force: true });
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
     * Overwrites a sheet's cached rows with a KNOWN-fresh value (the
     * caller's own optimistic local state right after a write) and
     * notifies subscribers immediately — no network round-trip.
     *
     * writeRow()/deleteRow() are optimistic: they resolve before the real
     * POST lands, and mark the sheet's cache stale so the NEXT read
     * revalidates. But a caller that immediately re-reads that sheet
     * (e.g. Shell.refreshGlobalAlerts() right after toggling the black
     * flag or posting an announcement, so the header pill/banner picks
     * up the change on this page and every other cached page) races
     * that still-in-flight POST — the GET can return the OLD server
     * value, so the just-made change appears to silently revert until a
     * manual reload. Calling this right after updating local state
     * (with the same rows the local re-render already used) closes that
     * race: any dependent read sees the correct data instantly, and the
     * real write still lands/reconciles the cache in the background as
     * usual.
     */
    setCachedRows(sheetName, rows, extraParams = {}) {
      const key = cacheKey(sheetName, extraParams);
      const data = { rows: rows || [] };
      const entry = { data, fetchedAt: Date.now() };
      cache.set(key, entry);
      persistToStorage_(key, entry);
      notifySubscribers_(key, data);
    },

    /**
     * Clears the read cache and forces a fresh fetch of every sheet
     * currently cached, notifying subscribers as each comes back. This
     * is what the dedicated Refresh button calls — a real, visible,
     * "go get everything again" action, distinct from the instant
     * cached-render every page does automatically on load.
     */
    async hardRefresh() {
      // Deliberately does NOT clear the cache — it marks every entry
      // STALE instead. The page's own load() (called right after this by
      // Shell's hardRefresh) re-runs getSheetCached(), and because those
      // entries are now stale they revalidate against the network past
      // the freshness gate — so the Refresh button always fetches fresh
      // data even for a sheet read seconds ago. Keeping the (stale) data
      // in the cache means pages render it instantly while the refetch is
      // in flight rather than blanking back to a "Loading…" spinner, and
      // it survives a refetch that hits a rate limit. Wiping the cache
      // first used to blank the page and, stacked on the header's own
      // refresh spinner, looked broken (two spinners).
      cache.forEach((entry, key) => {
        entry.fetchedAt = 0;
        persistToStorage_(key, entry);
      });
      return Array.from(cache.keys());
    },

    /**
     * Fire-and-forget background fetch for a list of sheet names not
     * necessarily used by THIS page — called once per page load (see
     * Shell.init) so that by the time someone navigates to another
     * page, its data is already warm in the persisted cache and renders
     * instantly instead of waiting on the network. Skips a sheet
     * entirely if it was already fetched within maxAgeMs (so clicking
     * around quickly doesn't re-hit the backend on every single load) or
     * if a page is already fetching it on its own (inFlight).
     *
     * maxAgeMs defaults to the Worker's own KV read-cache lifetime
     * (READ_CACHE_TTL_SECONDS in worker/src/auth.js, 5 minutes) rather
     * than something shorter — re-warming more often than that can never
     * see fresher data anyway, since the Worker itself won't re-hit the
     * Sheets API until its cache entry expires. It's also deliberately
     * LONGER than Shell's warmCache poll interval (currently 3 minutes):
     * if it were shorter than (or equal to) the poll interval, every
     * single tick would find every sheet already older than maxAgeMs and
     * re-fetch the whole set unconditionally, making this filter a
     * structural no-op. A write still gets picked up immediately
     * regardless of this window — writeRow/deleteRow call
     * markSheetStale_, which resets fetchedAt to 0, so the very next
     * warm (or read) treats that sheet as maximally stale no matter what
     * maxAgeMs is set to.
     *
     * Everything still stale after that filtering is warmed in a SINGLE
     * batchRead request rather than one read per sheet — so warming a
     * dozen sheets costs one Worker invocation, not a dozen, which is the
     * dominant steady-state backend cost for a device left open all day.
     */
    warmCache(sheetNames, { maxAgeMs = 300000 } = {}) {
      const stale = (sheetNames || []).filter((name) => {
        const key = cacheKey(name, {});
        // A page is already fetching this on its own — its read will fill
        // the cache, so don't also pull it into the warm batch.
        if (inFlight.has(key)) return false;
        const cached = cache.get(key);
        return !(cached && Date.now() - cached.fetchedAt < maxAgeMs);
      });
      if (!stale.length) return;
      batchFetchSheets_(stale).catch(() => { /* best-effort — the page that actually needs a sheet issues its own read */ });
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
      const effectiveMatch = (Array.isArray(matchColumns) && matchColumns.length)
        ? matchColumns
        : (matchColumn ? [matchColumn] : []);

      // Skip a write that wouldn't change anything. Only on the optimistic
      // path (the default, high-volume one): an { optimistic: false } caller
      // is awaiting the server's real result — often to catch a permission
      // error before mutating its UI — so it must always make the round-trip
      // rather than get a synthetic "noop" back. A no-op skip leaves the
      // cache exactly as-is (it already equals the server) and deliberately
      // does NOT markSheetStale, so it also avoids the follow-up revalidation
      // read — no write, no invalidate, no repopulation.
      if (optimistic && updateWouldBeNoop_(sheetName, rowData, effectiveMatch)) {
        return Promise.resolve({ ok: true, action: "noop", row: rowData });
      }

      // This sheet's cached rows no longer reflect reality — force the
      // next read to revalidate rather than serve pre-write data from the
      // freshness window.
      markSheetStale_(sheetName);
      const body = { sheet: sheetName, row: rowData, matchColumn, matchColumns };
      if (!optimistic) return performWrite_("write", body);
      // Already known offline — go straight to the outbox instead of
      // wasting up to ~30s (a full request timeout plus performWrite_'s
      // own retry) attempting a request that has no chance of landing.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        enqueueOutbox_("write", body);
        return Promise.resolve({ ok: true, action: "queued", row: rowData });
      }
      // Fire the real request in the background (errors surface via
      // onSyncStatusChange -> "error", not a rejected promise here) and
      // resolve immediately so the caller can update its own UI without
      // waiting on the network round-trip. If it fails specifically
      // because the device is offline/unreachable, park it in the durable
      // outbox to replay on reconnect instead of silently dropping it.
      performWrite_("write", body).catch((err) => {
        if (isNetworkError_(err)) enqueueOutbox_("write", body);
      });
      return Promise.resolve({ ok: true, action: "queued", row: rowData });
    },

    /**
     * Deletes a row matched by matchColumn/matchColumns against
     * matchValues. Same optimistic-by-default behavior as writeRow.
     */
    deleteRow(sheetName, matchValues, { matchColumn = null, matchColumns = null, optimistic = true } = {}) {
      markSheetStale_(sheetName);
      const body = { sheet: sheetName, matchValues, matchColumn, matchColumns };
      if (!optimistic) return performWrite_("delete", body);
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        enqueueOutbox_("delete", body);
        return Promise.resolve({ ok: true, action: "queued" });
      }
      performWrite_("delete", body).catch((err) => {
        if (isNetworkError_(err)) enqueueOutbox_("delete", body);
      });
      return Promise.resolve({ ok: true, action: "queued" });
    },

    /** Subscribe to sync status changes: cb(status, pendingCount). Returns an unsubscribe function. */
    onSyncStatusChange(cb) {
      syncListeners.add(cb);
      cb(syncStatus, totalPending_());
      return () => syncListeners.delete(cb);
    },

    /** Fires cb(action, body) each time a write/delete lands in the offline outbox — see the comment on outboxListeners above. */
    onOutboxEnqueue(cb) {
      outboxListeners.add(cb);
      return () => outboxListeners.delete(cb);
    },

    getSyncStatus() {
      return { status: syncStatus, pending: totalPending_() };
    },

    /**
     * Replay any writes queued while offline. Called by Shell on page
     * load / when the tab becomes visible, and automatically on the
     * browser's `online` event. No-ops when the outbox is empty.
     */
    flushOutbox() {
      return flushOutbox_();
    },

    /** Number of writes currently waiting in the offline outbox. */
    pendingOutboxCount() {
      return outbox.length;
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
    },

    /**
     * Returns { enabled, vapidPublicKey } describing whether Web Push is
     * configured on the backend. enabled is false (and vapidPublicKey
     * null) when no VAPID keys are set, so the client can hide the
     * "enable alerts" affordance entirely. Requires a signed-in session.
     */
    getPushConfig() {
      return request("pushConfig", { requireDevice: true, requireSession: true });
    },

    /**
     * Registers this device's Web Push subscription with the backend so
     * it receives Announcement / Black Flag alerts. subscription is the
     * PushSubscription.toJSON() shape ({ endpoint, keys: { p256dh, auth } }).
     * Idempotent — re-registering the same endpoint just refreshes it.
     */
    savePushSubscription(subscription) {
      return request("savePushSubscription", {
        method: "POST",
        body: { subscription },
        requireDevice: true,
        requireSession: true
      });
    },

    // ---- Admin (Administrator page only; server re-checks "admin") ----

    /** Lists every StaffAccess position (Pages/Flights/hasPassword — never the password itself). */
    adminListStaffAccess() {
      return request("adminListStaffAccess", { requireDevice: true, requireSession: true });
    },

    /**
     * Creates or updates a StaffAccess position. row = { position, pages[],
     * flights[], password?, clearPassword? }. Omitting password keeps the
     * existing one; clearPassword:true removes it.
     */
    adminSaveStaffAccess(row) {
      return request("adminSaveStaffAccess", {
        method: "POST",
        body: row,
        requireDevice: true,
        requireSession: true
      });
    },

    /** Deletes a StaffAccess position by name. */
    adminDeleteStaffAccess(position) {
      return request("adminDeleteStaffAccess", {
        method: "POST",
        body: { position },
        requireDevice: true,
        requireSession: true
      });
    },

    /** Returns recent LoginLog entries, newest first (device + session attempts). */
    adminListLoginLog({ limit = 200 } = {}) {
      return request("adminListLoginLog", {
        params: { limit },
        requireDevice: true,
        requireSession: true
      });
    },

    /**
     * Returns the current admin-adjustable Worker settings (see
     * pages/admin.html's "Worker Settings" tab and worker/src/runtimeConfig.js):
     * { readCacheTtlSeconds, rateLimitPerMinute, maintenanceMode,
     * deviceTokenLifetimeHoursPersonal, deviceTokenLifetimeHoursShared }.
     */
    adminGetWorkerConfig() {
      return request("adminGetWorkerConfig", { requireDevice: true, requireSession: true });
    },

    /** Saves a partial patch of Worker settings; the backend clamps every value to a sane range and returns the resulting full config. */
    adminSaveWorkerConfig(config) {
      return request("adminSaveWorkerConfig", {
        method: "POST",
        body: { config },
        requireDevice: true,
        requireSession: true
      });
    }
  };
})();
