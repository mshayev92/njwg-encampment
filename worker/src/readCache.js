/**
 * KV-backed cache of a sheet's full getAllValues() result — the same
 * purpose as getCachedSheetValues_ in the old Code.gs, just backed by
 * Workers KV instead of Apps Script's CacheService. Reads are the hot
 * path (every page load warms several sheets), so within
 * READ_CACHE_TTL_SECONDS a repeat read is served from KV instead of
 * re-hitting the Sheets API. Writes invalidate the affected sheet's
 * entry immediately (see invalidateSheetCache), so nobody reads stale
 * data past their own write.
 */

import { getAllValues } from "./sheets.js";
import { READ_CACHE_TTL_SECONDS } from "./auth.js";

function cacheKeyFor(sheetName) {
  return "sheetvals:" + sheetName;
}

export async function getCachedSheetValues(env, sheetName) {
  const cached = await env.NJWG_KV.get(cacheKeyFor(sheetName), "json");
  if (cached) return cached;

  const values = await getAllValues(env, sheetName);
  // KV values are capped at 25MB, comfortably larger than any sheet this
  // app deals with, so unlike the old 100KB CacheService limit this
  // essentially never needs a fallback path.
  //
  // Workers KV rejects any expirationTtl under 60 seconds ("Invalid
  // expiration_ttl... must be at least 60"), so the backend cache here
  // can't go as low as READ_CACHE_TTL_SECONDS (20s, inherited from the
  // old Code.gs/CacheService value) — floor it at KV's minimum instead.
  // This isn't a regression: the frontend (js/api.js FRESH_TTL_MS) still
  // gates its OWN network calls at 20s, so a person never waits longer
  // than that for their own actions to show up; this just means a
  // second person's read of the same sheet can be up to 60s stale
  // instead of 20s, which writes still bypass immediately via
  // invalidateSheetCache below.
  const ttl = Math.max(60, READ_CACHE_TTL_SECONDS);
  await env.NJWG_KV.put(cacheKeyFor(sheetName), JSON.stringify(values), { expirationTtl: ttl });

  return values;
}

export function invalidateSheetCache(env, sheetName) {
  return env.NJWG_KV.delete(cacheKeyFor(sheetName));
}
