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

import { getAllValues, batchGetValues, getSpreadsheetMeta } from "./sheets.js";
import { READ_CACHE_TTL_SECONDS } from "./auth.js";

function cacheKeyFor(sheetName) {
  return "sheetvals:" + sheetName;
}

function readCacheTtl() {
  // Workers KV rejects any expirationTtl under 60s — floor it there (see
  // the note in getCachedSheetValues below).
  return Math.max(60, READ_CACHE_TTL_SECONDS);
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
  await env.NJWG_KV.put(cacheKeyFor(sheetName), JSON.stringify(values), { expirationTtl: readCacheTtl() });

  return values;
}

/**
 * Reads several sheets at once, using the SAME per-sheet KV read cache as
 * getCachedSheetValues above. Returns { sheetName: values[][] } for every
 * requested name. The whole point is the miss path: every sheet not
 * already warm in KV is fetched in ONE Sheets values:batchGet call (see
 * batchGetValues) instead of one API round-trip each, and the whole thing
 * is one Worker invocation instead of one per sheet — this is what backs
 * the frontend's background cache-warming (js/api.js warmCache).
 *
 * A requested tab that doesn't exist yet (e.g. an inspection sheet no one
 * has written to) simply returns []: batchGet 400s the entire request if
 * any range names a missing tab, so misses are filtered against the
 * (KV-cached) spreadsheet metadata before the batch call, and absent tabs
 * are reported empty rather than auto-created — a background warm should
 * never mutate the sheet. The page's own on-demand read still auto-creates
 * the tab when it's genuinely first needed (see ensureAutoCreatedTab).
 */
export async function getCachedSheetValuesBatch(env, sheetNames) {
  const result = {};
  const misses = [];

  // 1. Serve whatever's already warm in KV, collecting the misses.
  await Promise.all(sheetNames.map(async (name) => {
    const cached = await env.NJWG_KV.get(cacheKeyFor(name), "json");
    if (cached) result[name] = cached;
    else misses.push(name);
  }));

  if (misses.length) {
    // 2. Only batch-fetch tabs that actually exist; metadata is KV-cached,
    //    so this guard is essentially free and avoids a 400 that would
    //    fail the whole batch. Missing tabs report empty.
    const meta = await getSpreadsheetMeta(env);
    const existing = misses.filter((n) => n in meta);
    misses.filter((n) => !(n in meta)).forEach((n) => { result[n] = []; });

    if (existing.length) {
      // 3. ONE Sheets API call for every cache-missed sheet.
      const fetched = await batchGetValues(env, existing);
      const ttl = readCacheTtl();
      await Promise.all(existing.map(async (name) => {
        const values = fetched[name] || [];
        result[name] = values;
        // Populate the same KV key the per-sheet read cache uses, so a
        // later individual read of this sheet is served from cache too.
        await env.NJWG_KV.put(cacheKeyFor(name), JSON.stringify(values), { expirationTtl: ttl });
      }));
    }
  }

  return result;
}

export function invalidateSheetCache(env, sheetName) {
  return env.NJWG_KV.delete(cacheKeyFor(sheetName));
}
