/**
 * Device/session token issuing+verification, rate limiting, and sheet
 * permission rules — a port of the equivalent sections of
 * apps-script/Code.gs to the Workers runtime (Web Crypto instead of
 * Apps Script's Utilities service, KV instead of CacheService).
 *
 * Token format is unchanged conceptually: base64url(JSON payload) + "." +
 * base64url(HMAC-SHA256 signature). The frontend (js/api.js) never
 * inspects token contents, only stores and replays them, so this only
 * needs to be internally consistent with itself.
 */

// ---- CONFIG (mirrors Code.gs) ---------------------------------------------

export const ALLOWED_SHEETS = [
  "Roster", "Schedule", "UniformInspections", "RoomInspections", "Announcements", "BlackFlagStatus", "Notes"
];

export const DEVICE_TOKEN_LIFETIME_HOURS_PERSONAL = 24 * 14;
export const DEVICE_TOKEN_LIFETIME_HOURS_SHARED = 8;

export const SHEET_PERMISSIONS = {
  Roster:             { read: "any", write: "page" },
  Schedule:           { read: "any", write: "page" },
  UniformInspections: { read: "any", write: "any" },
  RoomInspections:    { read: "any", write: "any" },
  Announcements:      { read: "any", write: "page" },
  BlackFlagStatus:    { read: "any", write: "page" },
  Notes:              { read: "any", write: "any" }
};

export const PAGE_WRITE_GATES = {
  Roster:          { viewPage: "roster",        editPage: "edit-roster" },
  Schedule:        { viewPage: "schedule",       editPage: "edit-schedule" },
  Announcements:   { viewPage: "announcements",  editPage: "edit-announcements" },
  BlackFlagStatus: { viewPage: "announcements",  editPage: "edit-announcements" }
};

export const RATE_LIMIT_PER_MINUTE = 60;
export const READ_CACHE_TTL_SECONDS = 20;

export const UNIFORM_INSPECTION_COLUMNS = [
  "StudentCapId", "StudentName", "Flight", "InspectingPosition",
  "Date", "Timestamp",
  "Haircut", "CosmeticsOrShave", "CleanlinessPress", "ShirtTuck",
  "PatchesNametag", "InsigniaRibbons", "GigLine",
  "BootBlousingShoeShine", "MilitaryBearingCourtesy",
  "TotalPoints", "Notes"
];
export const ROOM_INSPECTION_COLUMNS = [
  "StudentCapId", "StudentName", "Flight", "InspectingPosition",
  "Date", "Timestamp",
  "HospitalCorners", "Pillow", "Collar", "SheetsBlanket", "Shoes",
  "Towel", "TopShelf", "Clothes", "TopOfDrawerCabinet",
  "TotalPoints", "Notes"
];
export const ANNOUNCEMENT_COLUMNS = ["Id", "Timestamp", "Position", "Message"];
// Subject is free text — either a name typed/picked from the Roster (a
// person can reference a cadet just by name, since CapId lookups are a
// nice-to-have, not required) or a plain non-cadet subject. Body holds
// sanitized rich-text HTML (see js/richtext.js). Flight is auto-filled
// client-side from the Roster when Subject exactly matches a cadet's
// name, blank otherwise — pages/notes.html uses it to scope a note's
// visibility to positions allowed to see that flight, same as
// Inspections/Roster/Overview (blank Flight = visible to everyone,
// same as a note with no cadet tied to it).
export const NOTES_COLUMNS = ["Id", "Timestamp", "AuthorPosition", "Subject", "Flight", "Body"];
export const BLACK_FLAG_COLUMNS = ["RecordKey", "Active", "UpdatedBy", "UpdatedAt"];

// ---- Hashing / signing ------------------------------------------------------

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashString(str) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return toHex(digest);
}

function base64UrlEncode(bytes) {
  let binary = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + ((4 - (str.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(env) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signPayload(env, payloadStr) {
  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadStr));
  return base64UrlEncode(sig);
}

export async function issueGenericToken(env, payload) {
  const fullPayload = { ...payload, iat: Date.now() };
  const payloadStr = base64UrlEncode(new TextEncoder().encode(JSON.stringify(fullPayload)));
  const signature = await signPayload(env, payloadStr);
  return `${payloadStr}.${signature}`;
}

export async function verifyToken(env, token) {
  if (!token) throw new Error("Missing token. Please sign in again.");

  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Malformed token. Please sign in again.");

  const [payloadStr, signature] = parts;
  const expectedSignature = await signPayload(env, payloadStr);

  // Constant-time-ish compare via Web Crypto's verify would be nicer,
  // but a straight string compare against an HMAC we just recomputed is
  // the same approach the previous Apps Script version used.
  if (signature !== expectedSignature) {
    throw new Error("Invalid token. Please sign in again.");
  }

  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadStr)));
  } catch (err) {
    throw new Error("Malformed token. Please sign in again.");
  }
}

export async function requireDeviceToken(env, deviceToken) {
  // Any failure verifying the device token — missing, malformed, wrong
  // type, or (most commonly, right after a SESSION_SECRET rotation like
  // switching backends) a signature mismatch — MUST surface as a message
  // containing "device". The frontend (js/api.js handleAuthFailure_)
  // classifies which gate to bounce to purely by pattern-matching the
  // error text (/device|passphrase/i vs /session token|invalid token/i),
  // and verifyToken()'s generic "Invalid token..."/"Malformed token..."
  // messages don't mention "device" — without this wrapper those get
  // misclassified as a SESSION error. That redirects index.html back to
  // itself instead of gate.html, and never clears the actually-broken
  // device token, producing an infinite reload loop.
  let payload;
  try {
    payload = await verifyToken(env, deviceToken);
  } catch (err) {
    throw new Error("Invalid device token. Please re-enter the passphrase.");
  }
  if (payload.type !== "device") throw new Error("Invalid device token. Please re-enter the passphrase.");
  if (Date.now() > payload.exp) throw new Error("Device access expired. Please re-enter the passphrase.");
  return payload;
}

export async function requireSession(env, token) {
  const payload = await verifyToken(env, token);
  if (payload.type !== "session") throw new Error("Invalid session token. Please sign in again.");
  if (!payload.exp || Date.now() > payload.exp) {
    throw new Error("Session expired. Please sign in again.");
  }
  return payload;
}

export function nextMidnight() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
}

// ---- Rate limiting (isolate-local count, KV only for heavy keys) ----------
//
// Writing to KV on every request is what blows through Cloudflare's
// free-plan 1,000-writes/day cap, since this runs on nearly every
// authenticated request. Instead, each Worker isolate keeps an in-memory
// counter per rate-limit key and enforces the cap against that exact
// count — the accept/reject decision never depends on KV. KV is used
// only to *persist* a key's count, and only once that count is heavy
// enough (>= RATE_LIMIT_COORD_THRESHOLD, half the cap) that coordinating
// across isolates / surviving an isolate eviction actually matters.
//
// The upshot for write volume: normal light traffic — a staff device
// doing a handful of requests a minute, nowhere near 60 — never writes
// to KV at all. That's the overwhelming majority of requests, so the
// rate limiter's KV writes drop to essentially zero in steady state.
// Writes only start once a single key is genuinely bursting toward the
// cap, and even then they're throttled to every RATE_LIMIT_FLUSH_EVERY
// increments; once a key is blocked at the cap it writes nothing further
// that window (the guard throws before any write).
//
// What this trades away: enforcement is now fundamentally per-isolate,
// with KV as a best-effort shared floor for heavy keys. If requests for
// one key are spread across several isolates in the same 60s window,
// each isolate enforces its own 60/min and only inherits another
// isolate's count when it (re)seeds at the start of its window, so the
// effective cap can rise toward 60 x (isolates handling that key). For
// this app's traffic — a few dozen staff devices, not a public-facing
// service under adversarial distributed load — that's an acceptable
// loosening of precision on a soft cap: it still hard-caps any single
// runaway/abusive client per isolate, and heavy keys still persist so a
// burst can't be reset for free by isolate churn. It's the same class of
// caveat the old non-atomic read-then-write already carried (and the old
// CacheService limiter in Code.gs).
//
// This is Workers-specific (it leans on isolate-lifetime module state)
// and deliberately NOT ported to Code.gs: Apps Script's CacheService
// isn't write-count-limited the way free-plan Workers KV is, so there's
// no equivalent quota problem to solve there.
const RATE_LIMIT_COORD_THRESHOLD = Math.floor(RATE_LIMIT_PER_MINUTE / 2);
const RATE_LIMIT_FLUSH_EVERY = 5;
const rateLimitMemory = new Map(); // cacheKey -> { count, windowStart, unflushed }

export async function checkRateLimit(env, key) {
  if (!key) return;
  const cacheKey = "rl:" + (await hashString(String(key)));
  const now = Date.now();

  let entry = rateLimitMemory.get(cacheKey);
  if (!entry || now - entry.windowStart >= 60000) {
    // Fresh window: inherit any persisted count from another isolate (or
    // from this isolate before an eviction). Light keys never persisted
    // anything, so this reads null and starts at 0 — reads aren't the
    // quota-limited operation, writes are.
    const stored = Number((await env.NJWG_KV.get(cacheKey)) || 0);
    entry = { count: stored, windowStart: now, unflushed: 0 };
    rateLimitMemory.set(cacheKey, entry);
  }

  if (entry.count >= RATE_LIMIT_PER_MINUTE) {
    throw new Error("Too many requests. Please wait a moment and try again.");
  }

  entry.count++;
  entry.unflushed++;

  // Persist only heavy keys, and only every Nth increment (or on the
  // exact request that reaches the cap, so a concurrent isolate can see
  // the block promptly). Everything below the threshold stays purely
  // in-memory and costs zero KV writes.
  const heavy = entry.count >= RATE_LIMIT_COORD_THRESHOLD;
  const reachedCap = entry.count >= RATE_LIMIT_PER_MINUTE;
  if (heavy && (entry.unflushed >= RATE_LIMIT_FLUSH_EVERY || reachedCap)) {
    await env.NJWG_KV.put(cacheKey, String(entry.count), { expirationTtl: 60 });
    entry.unflushed = 0;
  }
}

export function assertAllowedSheet(sheetName) {
  if (!sheetName) throw new Error("Missing required 'sheet' parameter.");
  if (!ALLOWED_SHEETS.includes(sheetName)) {
    throw new Error(`Sheet tab "${sheetName}" is not allowed.`);
  }
}

export function assertPermission(sheetName, mode) {
  const rules = SHEET_PERMISSIONS[sheetName];
  if (!rules) throw new Error(`No permission rule defined for "${sheetName}".`);
  const required = rules[mode];
  if (required === "none") throw new Error(`${mode} is not permitted on "${sheetName}".`);
}

export function assertPageWriteAccess(sheetName, session) {
  const rules = SHEET_PERMISSIONS[sheetName];
  if (!rules || rules.write !== "page") return;

  const gate = PAGE_WRITE_GATES[sheetName];
  if (!gate) throw new Error(`No write-access page configured for "${sheetName}".`);

  const pages = (Array.isArray(session.pages) ? session.pages : []).map((p) => String(p).toLowerCase());

  if (!pages.includes(gate.viewPage)) {
    throw new Error(`You do not have permission to view ${sheetName}, so you can't edit it either.`);
  }
  if (!pages.includes(gate.editPage)) {
    throw new Error(`You do not have edit permission for ${sheetName}. Ask an Administrator to add "${gate.editPage}" to your position's Pages.`);
  }
}
