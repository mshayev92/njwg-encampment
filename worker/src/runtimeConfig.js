/**
 * Admin-adjustable operational knobs — the small set of values that used
 * to be hardcoded constants (READ_CACHE_TTL_SECONDS, RATE_LIMIT_PER_MINUTE,
 * the device token lifetimes) plus a new maintenance-mode switch. Stored
 * as ONE JSON blob in KV so an Administrator can tune them live from
 * pages/admin.html's "Worker Settings" tab instead of editing this file
 * and redeploying.
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
  readCacheTtlSeconds: 300,
  rateLimitPerMinute: 60,
  maintenanceMode: false,
  deviceTokenLifetimeHoursPersonal: 24 * 14,
  deviceTokenLifetimeHoursShared: 8
};

// Every numeric field is clamped to these bounds on save, so a mistyped
// value can't wedge the app (e.g. a rate limit of 0 locking everyone out,
// or a cache TTL of a week making a direct-Sheet edit invisible for days).
const BOUNDS = {
  readCacheTtlSeconds: { min: 60, max: 3600 },
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

  if ("readCacheTtlSeconds" in patch) {
    next.readCacheTtlSeconds = clampNumber(patch.readCacheTtlSeconds, BOUNDS.readCacheTtlSeconds, current.readCacheTtlSeconds);
  }
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

  await env.NJWG_KV.put(CONFIG_KV_KEY, JSON.stringify(next));
  cached = next;
  cachedAt = Date.now();
  return next;
}
