/**
 * Admin-adjustable operational knobs — the small set of values that used
 * to be hardcoded constants (RATE_LIMIT_PER_MINUTE, the device token
 * lifetimes) plus a new maintenance-mode switch. Stored as ONE JSON blob
 * in KV so an Administrator can tune them live from pages/admin.html's
 * "Worker Settings" tab instead of editing this file and redeploying.
 *
 * The sheet read-cache TTL used to live here too (readCacheTtlSeconds),
 * but it's a fixed constant again (READ_CACHE_TTL_SECONDS in
 * readCache.js) now that a direct Google Sheet edit is synced on demand
 * via a "Sync now" button (invalidateAllSheetCaches) instead of by
 * tuning how long the cache is allowed to go stale.
 *
 * Read path is isolate-local-cached for CONFIG_CACHE_MS, the same pattern
 * checkRateLimit already uses in auth.js for its own isolate-local
 * counters. That means making these live-editable costs AT MOST one extra
 * KV read per isolate per cache window (60s) — not one per request — so
 * it doesn't add per-request KV cost on top of what already existed when
 * these were plain constants. A save writes through immediately (both to
 * KV and this isolate's own cache), so the admin who just changed a value
 * sees it take effect right away; every OTHER isolate picks it up within
 * the next 60s, the same eventual-consistency window the rate limiter's
 * own KV coordination already has.
 */

const CONFIG_KV_KEY = "runtimeconfig";
const CONFIG_CACHE_MS = 60000;

export const DEFAULT_RUNTIME_CONFIG = {
  rateLimitPerMinute: 60,
  maintenanceMode: false,
  deviceTokenLifetimeHoursPersonal: 24 * 14,
  deviceTokenLifetimeHoursShared: 8,
  // { lowercased flight name -> "#rrggbb" }, populated by
  // adminSyncFlightColors (index.js) reading the ACTUAL cell background
  // colors off the Roster tab's Flight column — not hand-typed. Empty
  // until an admin runs the sync at least once; every page falls back to
  // APP_CONFIG.FLIGHT_COLORS (js/config.js) until then (see
  // Shell.flightColor). Readable by any signed-in session (see the
  // getFlightColors action) since flight-color accents show up on
  // ordinary staff pages, not just Admin.
  flightColors: {},
  // Lowercased names of every flight belonging to an "Advanced Training
  // School" position (a StaffAccess row with its ATS column checked —
  // see handleAdminSaveStaffAccess/computeAtsFlights_ in index.js, which
  // recomputes this automatically on every StaffAccess save/delete, the
  // same "admin edits the source, everyone reads the derived result"
  // shape flightColors above already uses). Readable by any signed-in
  // session (see the getAtsFlights action) — Overview's Flight Standings
  // and Awards' Weekly Standings both need to exclude these flights from
  // their rankings for every viewer, not just the ATS position itself.
  atsFlights: []
};

// Every numeric field is clamped to these bounds on save, so a mistyped
// value can't wedge the app (e.g. a rate limit of 0 locking everyone out,
// or a cache TTL of a week making a direct-Sheet edit invisible for days).
const BOUNDS = {
  rateLimitPerMinute: { min: 10, max: 300 },
  deviceTokenLifetimeHoursPersonal: { min: 1, max: 24 * 30 },
  deviceTokenLifetimeHoursShared: { min: 1, max: 24 * 7 }
};

let cached = null;
let cachedAt = 0;

export async function getRuntimeConfig(env) {
  const now = Date.now();
  if (cached && now - cachedAt < CONFIG_CACHE_MS) return cached;

  let stored = null;
  try {
    stored = await env.NJWG_KV.get(CONFIG_KV_KEY, "json");
  } catch {
    // KV hiccup — fall back to whatever's cached (possibly defaults);
    // never let a config read failure take down an ordinary request.
  }
  cached = { ...DEFAULT_RUNTIME_CONFIG, ...(stored || {}) };
  cachedAt = now;
  return cached;
}

function clampNumber(value, bounds, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(n)));
}

/** Merges `patch` onto the current config, clamping/validating each known field, persists it, and returns the new full config. */
export async function saveRuntimeConfig(env, patch) {
  const current = await getRuntimeConfig(env);
  const next = { ...current };

  if ("rateLimitPerMinute" in patch) {
    next.rateLimitPerMinute = clampNumber(patch.rateLimitPerMinute, BOUNDS.rateLimitPerMinute, current.rateLimitPerMinute);
  }
  if ("deviceTokenLifetimeHoursPersonal" in patch) {
    next.deviceTokenLifetimeHoursPersonal = clampNumber(patch.deviceTokenLifetimeHoursPersonal, BOUNDS.deviceTokenLifetimeHoursPersonal, current.deviceTokenLifetimeHoursPersonal);
  }
  if ("deviceTokenLifetimeHoursShared" in patch) {
    next.deviceTokenLifetimeHoursShared = clampNumber(patch.deviceTokenLifetimeHoursShared, BOUNDS.deviceTokenLifetimeHoursShared, current.deviceTokenLifetimeHoursShared);
  }
  if ("maintenanceMode" in patch) {
    next.maintenanceMode = !!patch.maintenanceMode;
  }
  if ("flightColors" in patch && patch.flightColors && typeof patch.flightColors === "object") {
    // Only keep entries that actually look like a hex color — this is
    // populated by our own getColumnBackgroundColorsByValue, but validate
    // anyway rather than trust a client-supplied object verbatim.
    const clean = {};
    for (const [name, color] of Object.entries(patch.flightColors)) {
      if (typeof name === "string" && /^#[0-9a-f]{6}$/i.test(String(color))) {
        clean[name.toLowerCase()] = String(color).toLowerCase();
      }
    }
    next.flightColors = clean;
  }
  if ("atsFlights" in patch && Array.isArray(patch.atsFlights)) {
    // Same shape as flightColors above — this is populated by our own
    // computeAtsFlights_ (index.js), never a client-supplied value, but
    // validated anyway rather than trusted verbatim.
    next.atsFlights = [...new Set(patch.atsFlights.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim().toLowerCase()))].sort();
  }

  await env.NJWG_KV.put(CONFIG_KV_KEY, JSON.stringify(next));
  cached = next;
  cachedAt = Date.now();
  return next;
}
