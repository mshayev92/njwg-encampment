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

import { getRuntimeConfig } from "./runtimeConfig.js";

// ---- CONFIG (mirrors Code.gs) ---------------------------------------------

export const ALLOWED_SHEETS = [
  "Roster", "Schedule", "UniformInspections", "RoomInspections", "PTInspections", "InspectionPeriods", "Announcements", "BlackFlagStatus", "Notes", "Observations",
  "HonorCadetRecommendations", "HonorFlightRecommendations", "FlightStandingsWeights", "PhysicalAssessments"
];

// Device token lifetimes, the KV read-cache TTL, and the per-token rate
// limit all used to be plain constants here. They're now admin-adjustable
// at runtime — see runtimeConfig.js (getRuntimeConfig/DEFAULT_RUNTIME_CONFIG)
// and pages/admin.html's "Worker Settings" tab — with the exact same
// default values these constants used to hold.

export const SHEET_PERMISSIONS = {
  Roster:             { read: "any", write: "page" },
  Schedule:           { read: "any", write: "page" },
  UniformInspections: { read: "any", write: "any" },
  RoomInspections:    { read: "any", write: "any" },
  PTInspections:      { read: "any", write: "any" },
  InspectionPeriods:  { read: "any", write: "page" },
  // Announcements/BlackFlagStatus have no separate edit-* pencil — page
  // access (the "announcements" token) already implies edit access, same
  // shape as Notes/Observations below.
  Announcements:      { read: "any", write: "any" },
  BlackFlagStatus:    { read: "any", write: "any" },
  Notes:              { read: "any", write: "any" },
  // Same shape as UniformInspections/Notes: any signed-in position that
  // can reach the Observations page can log an entry for a student —
  // no separate edit-observations grant. The friction that matters here
  // is keeping logging itself as cheap as possible (see the page for
  // the "one tap" logging flow this is designed around); page-level
  // visibility (whether "observations" is in a position's Pages at
  // all) is the only real gate, same as every other page.
  Observations:       { read: "any", write: "any" },
  // No separate edit-* pencil for Awards either — a Flight Commander can
  // only ever write its own flight's Honor Cadet row and a Squadron
  // Commander only its own Honor Flight row, which pages/recommendations.html
  // already enforces by which form it shows (single flight vs several) —
  // see submitterPosition/Flight in the row shape. Page-level visibility
  // (whether "recommendations" is in a position's Pages) is the only gate.
  HonorCadetRecommendations:  { read: "any", write: "any" },
  HonorFlightRecommendations: { read: "any", write: "any" },
  // Readable by any signed-in position (Overview needs it to compute
  // Flight Standings for everyone), but writing is NOT gated by a page
  // token at all — there's no "Overview" edit permission — it's gated by
  // assertAdmin directly in handleWrite's FlightStandingsWeights special
  // case below, the same way Roster gets a special case for its own
  // narrower write rules. "any" here just means "not blocked by
  // assertPermission before that admin check ever runs."
  FlightStandingsWeights: { read: "any", write: "any" },
  // Readable by any signed-in position (Awards/Overview need every
  // cadet's score to fold into their calculations), but writing is
  // restricted to an Administrator directly in handleWrite's
  // PhysicalAssessments special case below — same shape as
  // FlightStandingsWeights above — since the EOW assessment is
  // scored by IAT/admin staff only, not flight/squadron positions.
  PhysicalAssessments: { read: "any", write: "any" }
};

export const PAGE_WRITE_GATES = {
  Roster:            { viewPage: "roster",        editPage: "edit-roster" },
  Schedule:          { viewPage: "schedule",       editPage: "edit-schedule" },
  InspectionPeriods: { viewPage: "inspections",    editPage: "edit-inspections" }
};

// Backend (KV) read-cache lifetime (admin-adjustable default: 5 minutes;
// see runtimeConfig.js). This is the single biggest driver of KV WRITE
// volume: every time a sheet's cache entry expires and is then read, the
// Worker re-fetches it from Sheets and re-`put`s it into KV, so under
// continuous polling from open devices the write rate is ~ (number of
// sheets) / TTL.
//
// Raising it does NOT make app-driven changes stale: EVERY write/delete
// calls invalidateSheetCache (readCache.js), deleting the affected sheet's
// entry so the very next read misses and re-fetches fresh — a second
// device sees another device's write within its own client freshness
// window (js/api.js FRESH_TTL_MS, 20s), independent of this value. The
// ONLY thing this TTL bounds is how long an edit made DIRECTLY in the
// Google Sheet (bypassing the app entirely, e.g. an admin hand-editing a
// tab) can take to appear — a rare escape hatch, since Roster/Schedule/
// StaffAccess all have in-app editors that invalidate on save.

// InspectionPeriodId ties a scored entry back to the InspectionPeriods row
// it was filed under (blank for an ad-hoc entry logged with nothing
// scheduled) — see pages/inspections.html's Periods tab, which sums scores
// per period purely by matching this Id. Deleting a period only removes
// its InspectionPeriods row; already-scored entries (and this Id) persist.
export const UNIFORM_INSPECTION_COLUMNS = [
  "StudentCapId", "StudentName", "Flight", "InspectingPosition",
  "Date", "Timestamp", "InspectionPeriodId",
  "Haircut", "CosmeticsOrShave", "CleanlinessPress", "ShirtTuck",
  "PatchesNametag", "InsigniaRibbons", "GigLine",
  "BootBlousingShoeShine", "MilitaryBearingCourtesy",
  "TotalPoints", "Notes"
];
export const ROOM_INSPECTION_COLUMNS = [
  "StudentCapId", "StudentName", "Flight", "InspectingPosition",
  "Date", "Timestamp", "InspectionPeriodId",
  "HospitalCorners", "Pillow", "Collar", "SheetsBlanket", "Shoes",
  "Towel", "TopShelf", "Clothes", "TopOfDrawerCabinet",
  "TotalPoints", "Notes"
];
// Physical Fitness Test — the 5 line items are each OPTIONAL (unlike
// Uniform/Room, where every item must be scored before saving), since a
// cadet may not attempt every event on a given test day. Raw performance
// is recorded alongside a computed Pass ("1"/"0"/"") column per item —
// pass/fail is looked up against the AFI 36-2905-style age/sex chart in
// pages/inspections.html (PT_CHART), using Age/Sex read from the Roster
// at the time of the test. TotalPoints is how many attempted events
// passed; ItemsAttempted is how many of the 5 had a value entered at all
// — the denominator, since it varies test to test.
export const PT_INSPECTION_COLUMNS = [
  "StudentCapId", "StudentName", "Flight", "InspectingPosition",
  "Date", "Timestamp", "InspectionPeriodId", "Age", "Sex",
  "PacerLaps", "PacerLapsPass",
  "MileRunTime", "MileRunTimePass",
  "CurlUps", "CurlUpsPass",
  "PushUps", "PushUpsPass",
  "SitReach", "SitReachPass",
  "TotalPoints", "ItemsAttempted", "Notes"
];
// A scheduled inspection period: a Date plus what's being inspected that
// day. Category is "uniform" or "room"; UniformType ("OCP/ABU" or "Blues")
// is only meaningful when Category is "uniform" — blank for a room
// period. Surfaced on pages/inspections.html so a person starting a new
// inspection sees what's scheduled for today rather than guessing.
// Category is "uniform", "room", or "pt". "pt" is kept ONLY for backend/
// data-model compatibility with any PT periods scheduled before this
// option was pulled from the front end (see pages/inspections.html's
// period-type toggle, which no longer offers a "PT" button) — a future
// pass may re-enable scheduling PT periods from the UI, so the category
// and its scoring path (PTInspections, PT_INSPECTION_COLUMNS above)
// stay fully intact, just unreachable from the Inspect tab's own UI.
export const INSPECTION_PERIOD_COLUMNS = ["Id", "Date", "Category", "UniformType", "CreatedBy", "CreatedAt"];
// The EOW Physical Assessment — a single overall score (0-34) per
// cadet per date, distinct from the per-item PT_INSPECTION_COLUMNS test
// above. Entered by Administrators only (see PhysicalAssessments' write
// gate in SHEET_PERMISSIONS/handleWrite's special case) since this
// assessment's scoring is an admin/IAT-only responsibility, not
// something flight/squadron positions log — pages/inspections.html only
// shows this type's tile/scorecard to a signed-in Administrator.
export const PHYSICAL_ASSESSMENT_COLUMNS = [
  "StudentCapId", "StudentName", "Flight", "InspectingPosition",
  "Date", "Timestamp", "InspectionPeriodId",
  "Score", "Notes"
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
// same as a note with no cadet tied to it). SeenAt is blank until the
// ToPosition recipient's own device actually renders this note (see
// maybeMarkNoteSeen_ in pages/notes.html) — lets the AUTHOR see whether a
// directed note has actually been opened, not just delivered.
export const NOTES_COLUMNS = ["Id", "Timestamp", "AuthorPosition", "Subject", "Flight", "Body", "ToPosition", "SeenAt"];
export const BLACK_FLAG_COLUMNS = ["RecordKey", "Active", "UpdatedBy", "UpdatedAt"];
// Singleton row (RecordKey "singleton", same convention as
// BlackFlagStatus above) holding the weights pages/overview.html's
// Flight Standings card blends into each flight's score. Deliberately a
// SEPARATE sheet/mechanism from Recommendations' own per-device,
// localStorage-only award-ranking weights (njwg_award_weights_v2) — that
// one is a personal judgment call for picking an Honor Cadet/Flight;
// this one is shared across every device so Standings reads the same
// way for everyone, and is only editable by an Administrator (see
// handleWrite's FlightStandingsWeights special case in index.js).
// Values are the same 0-100-ish shares computeFlightStandings() in
// overview.html already used as hardcoded defaults.
export const FLIGHT_STANDINGS_WEIGHTS_COLUMNS = ["RecordKey", "Uniform", "Room", "Assessment", "PositiveObservations", "ConcernObservations", "UpdatedBy", "UpdatedAt"];
// One row per logged observation — deliberately append-only (no
// matchColumns on write from pages/observations.html), so tapping the
// same tag on the same student twice in a week records two separate
// timestamped events rather than overwriting a single "current status"
// per student. That's the point: Trends counts EVENTS, not a snapshot,
// which is what makes low-volume flights visible as low-volume rather
// than indistinguishable from a flight that simply has calmer cadets.
// Category is one of a small fixed set (leadership, followership,
// teamwork, bearing, initiative, effort, general); Tag is either a
// preset short phrase from that category or blank for a free-text-only
// "general" entry. Sentiment is "positive" | "concern" — deliberately
// binary, not a 1-5 scale, so two different raters logging the same
// moment are far less likely to disagree.
export const OBSERVATION_COLUMNS = [
  "Id", "StudentCapId", "StudentName", "Flight",
  "LoggerPosition", "Timestamp",
  "Category", "Tag", "Sentiment", "Note"
];
// BE Form 60-13 "Recommendation for Daily Awards", Part I (Honor Cadet),
// digitized. DATE SUBMITTED / TD SUBMITTED are dropped — the app already
// knows Date/Timestamp — and the paper form's typed Flight/CC + Student
// identity fields become SubmittedByPosition (from the session) and a
// Roster pick (StudentCapId/StudentName/Flight), rather than free text.
// No endorse/signature step: that's the Squadron/CC review workflow on
// paper, which this app doesn't reproduce — see HonorFlightRecommendations,
// submitted independently by squadron-scoped positions.
export const HONOR_CADET_RECOMMENDATION_COLUMNS = [
  "Id", "Date", "Timestamp", "SubmittedByPosition", "Flight",
  "StudentCapId", "StudentName",
  "DrillBarracksUniforms", "AcademicsKnowledge", "TeamworkLeadershipConduct", "AdditionalNotes"
];
// BE Form 60-13, Part II (Honor Flight), digitized — submitted by
// squadron-scoped positions, independently of Honor Cadet recommendations.
export const HONOR_FLIGHT_RECOMMENDATION_COLUMNS = [
  "Id", "Date", "Timestamp", "SubmittedByPosition", "Squadron", "Flight",
  "DrillBarracksUniforms", "AcademicsKnowledge", "TeamworkLeadershipConduct", "AdditionalNotes"
];

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

// Memoized per isolate: env.SESSION_SECRET is a binding that's constant
// for the isolate's life, and the derived CryptoKey is reusable for both
// sign and verify — so import it once and reuse it instead of re-importing
// on every signPayload/verifyToken, which runs at least twice per request
// (the device token and the session token are both verified). Caching the
// Promise (rather than the resolved key) is race-free and idiomatic. A
// SESSION_SECRET rotation replaces the isolate with a fresh one, so this
// can never serve a key derived from a stale secret.
let hmacKeyPromise = null;

function hmacKey(env) {
  if (!hmacKeyPromise) {
    hmacKeyPromise = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.SESSION_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );
  }
  return hmacKeyPromise;
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

  // Verify the signature with Web Crypto's HMAC verify rather than
  // recomputing the HMAC and string-comparing it: verify is constant-time
  // (no early-exit on the first differing byte, so it leaks nothing about
  // the expected signature through timing) and is the correct primitive
  // for the job. A malformed signature that won't even base64url-decode is
  // simply an invalid token.
  const key = await hmacKey(env);
  let valid = false;
  try {
    valid = await crypto.subtle.verify("HMAC", key, base64UrlDecode(signature), new TextEncoder().encode(payloadStr));
  } catch (err) {
    valid = false;
  }
  if (!valid) {
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
// enough (>= half the cap) that coordinating across isolates / surviving
// an isolate eviction actually matters.
//
// The cap itself (rateLimitPerMinute, admin-adjustable default 60 — see
// runtimeConfig.js) is read once per call via getRuntimeConfig, which is
// isolate-cached for 60s, so tuning it live doesn't add a KV read to
// every request either.
//
// The upshot for write volume: normal light traffic — a staff device
// doing a handful of requests a minute, nowhere near the cap — never
// writes to KV at all. That's the overwhelming majority of requests, so
// the rate limiter's KV writes drop to essentially zero in steady state.
// Writes only start once a single key is genuinely bursting toward the
// cap, and even then they're throttled to every RATE_LIMIT_FLUSH_EVERY
// increments; once a key is blocked at the cap it writes nothing further
// that window (the guard throws before any write).
//
// What this trades away: enforcement is now fundamentally per-isolate,
// with KV as a best-effort shared floor for heavy keys. If requests for
// one key are spread across several isolates in the same 60s window,
// each isolate enforces its own cap and only inherits another isolate's
// count when it (re)seeds at the start of its window, so the effective
// cap can rise toward cap x (isolates handling that key). For this app's
// traffic — a few dozen staff devices, not a public-facing service under
// adversarial distributed load — that's an acceptable loosening of
// precision on a soft cap: it still hard-caps any single runaway/abusive
// client per isolate, and heavy keys still persist so a burst can't be
// reset for free by isolate churn. It's the same class of caveat the old
// non-atomic read-then-write already carried (and the old CacheService
// limiter in Code.gs).
//
// This is Workers-specific (it leans on isolate-lifetime module state)
// and deliberately NOT ported to Code.gs: Apps Script's CacheService
// isn't write-count-limited the way free-plan Workers KV is, so there's
// no equivalent quota problem to solve there.
const RATE_LIMIT_FLUSH_EVERY = 5;
const rateLimitMemory = new Map(); // cacheKey -> { count, windowStart, unflushed }

export async function checkRateLimit(env, key) {
  if (!key) return;
  const { rateLimitPerMinute } = await getRuntimeConfig(env);
  const coordThreshold = Math.floor(rateLimitPerMinute / 2);
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

  if (entry.count >= rateLimitPerMinute) {
    throw new Error("Too many requests. Please wait a moment and try again.");
  }

  entry.count++;
  entry.unflushed++;

  // Persist only heavy keys, and only every Nth increment (or on the
  // exact request that reaches the cap, so a concurrent isolate can see
  // the block promptly). Everything below the threshold stays purely
  // in-memory and costs zero KV writes.
  const heavy = entry.count >= coordThreshold;
  const reachedCap = entry.count >= rateLimitPerMinute;
  if (heavy && (entry.unflushed >= RATE_LIMIT_FLUSH_EVERY || reachedCap)) {
    await env.NJWG_KV.put(cacheKey, String(entry.count), { expirationTtl: 60 });
    entry.unflushed = 0;
  }
}

// ---- Per-IP auth abuse prevention (deviceLogin / login) -------------------
//
// checkRateLimit() above is keyed by TOKEN, which is exactly right for
// authenticated read/write/delete — but the two secret-guessing endpoints,
// deviceLogin (the shared passphrase) and login (a position's password,
// e.g. CCT/Administrator), happen BEFORE any token exists. Those were
// previously throttled only by a single GLOBAL key ("deviceLogin", or
// "login:<position>") shared across every caller — which caps total
// guesses per minute, but doesn't stop one attacker from consuming that
// whole shared budget (locking out legitimate staff trying to sign in
// during the same window) and doesn't get any harder for a persistent
// attacker over time.
//
// This adds a PER-IP layer on top: a tight per-IP attempt-rate cap, plus
// an escalating lockout once an IP racks up repeated FAILURES specifically
// (not just requests) — 5 wrong guesses locks that IP out for 5 minutes,
// doubling on each subsequent lockout up to a 2-hour ceiling. A genuine
// staff member fat-fingering a passphrase twice is unaffected; a script
// grinding through a wordlist gets slower, not faster, and can no longer
// burn through everyone else's shared quota to do it.
//
// IP-keyed KV writes are inherently bounded by how often someone actually
// attempts to log in — rare in steady state, and only spike under an
// actual attack, which is exactly when paying for the write is worth it.
// checkAuthAttemptRate below still applies the SAME isolate-local-memory
// + flush-every-Nth-increment coordination checkRateLimit uses above
// (rather than a KV write on every single call) — the "rare in steady
// state" framing was true of how often the endpoint is CALLED, but the
// original version still wrote to KV on every one of those calls, which
// adds up across every device's normal sign-in traffic even though it's
// not an attack. Batching it the same way costs nothing during an actual
// attack (the cap is still enforced per-isolate against an in-memory
// count, and heavy keys still persist so a burst can't be reset for free
// by isolate churn — the failure-based escalating lockout below is the
// hard defense either way, unaffected by this).

export function getClientIp(request) {
  // CF-Connecting-IP is set by Cloudflare's edge on every request reaching
  // a Worker and can't be spoofed by the client (Cloudflare overwrites
  // whatever the client sends) — the correct IP source in this runtime,
  // unlike X-Forwarded-For which a client could forge.
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

const AUTH_ATTEMPT_LIMIT_PER_MINUTE = 10;
const AUTH_FAILURE_LOCKOUT_THRESHOLD = 5;
const AUTH_FAILURE_WINDOW_SECONDS = 10 * 60;
const AUTH_LOCKOUT_BASE_SECONDS = 5 * 60;
const AUTH_LOCKOUT_MAX_SECONDS = 2 * 60 * 60;
const AUTH_LOCKOUT_HISTORY_SECONDS = 24 * 60 * 60;

/** Throws if this IP is currently serving out an escalating lockout. */
export async function assertNotLockedOut(env, ip) {
  const lockKey = "authlock:" + (await hashString(ip));
  const locked = await env.NJWG_KV.get(lockKey);
  if (locked) {
    throw new Error("Too many failed attempts. Please wait before trying again.");
  }
}

const AUTH_ATTEMPT_FLUSH_EVERY = 3;
const authAttemptMemory = new Map(); // cacheKey -> { count, windowStart, unflushed }

/**
 * Tight per-IP cap on how often an auth endpoint can even be CALLED,
 * independent of whether the attempt succeeds — bounds raw request
 * volume (and thus Sheets API / Worker cost) from a single source before
 * the failure-based lockout below ever has to kick in. Same isolate-
 * local-memory + throttled-persistence shape as checkRateLimit above
 * (see its own big comment for the full reasoning/tradeoffs) — a normal
 * device signing in doesn't get anywhere near AUTH_ATTEMPT_LIMIT_PER_MINUTE,
 * so it costs zero KV writes; only a key actually bursting toward the cap
 * (i.e., something worth coordinating across isolates for) writes at all.
 */
export async function checkAuthAttemptRate(env, ip) {
  const cacheKey = "authrate:" + (await hashString(ip));
  const now = Date.now();

  let entry = authAttemptMemory.get(cacheKey);
  if (!entry || now - entry.windowStart >= 60000) {
    const stored = Number((await env.NJWG_KV.get(cacheKey)) || 0);
    entry = { count: stored, windowStart: now, unflushed: 0 };
    authAttemptMemory.set(cacheKey, entry);
  }

  if (entry.count >= AUTH_ATTEMPT_LIMIT_PER_MINUTE) {
    throw new Error("Too many attempts. Please wait a moment and try again.");
  }

  entry.count++;
  entry.unflushed++;

  const coordThreshold = Math.floor(AUTH_ATTEMPT_LIMIT_PER_MINUTE / 2);
  const heavy = entry.count >= coordThreshold;
  const reachedCap = entry.count >= AUTH_ATTEMPT_LIMIT_PER_MINUTE;
  if (heavy && (entry.unflushed >= AUTH_ATTEMPT_FLUSH_EVERY || reachedCap)) {
    await env.NJWG_KV.put(cacheKey, String(entry.count), { expirationTtl: 60 });
    entry.unflushed = 0;
  }
}

/**
 * Records whether this IP's auth attempt succeeded or failed. A success
 * clears its failure count. A failure increments it; hitting the
 * threshold locks the IP out for an escalating duration (doubling per
 * repeat lockout, capped at 2 hours) and resets the failure counter —
 * the lockout itself is what continues to apply while it's active.
 */
export async function recordAuthResult(env, ip, success) {
  const hashedIp = await hashString(ip);
  const failKey = "authfail:" + hashedIp;

  if (success) {
    await env.NJWG_KV.delete(failKey);
    return;
  }

  const failures = Number((await env.NJWG_KV.get(failKey)) || 0) + 1;
  if (failures >= AUTH_FAILURE_LOCKOUT_THRESHOLD) {
    const lockCountKey = "authlockcount:" + hashedIp;
    const priorLockouts = Number((await env.NJWG_KV.get(lockCountKey)) || 0);
    const lockSeconds = Math.min(
      AUTH_LOCKOUT_BASE_SECONDS * Math.pow(2, priorLockouts),
      AUTH_LOCKOUT_MAX_SECONDS
    );
    await env.NJWG_KV.put("authlock:" + hashedIp, "1", { expirationTtl: lockSeconds });
    await env.NJWG_KV.put(lockCountKey, String(priorLockouts + 1), { expirationTtl: AUTH_LOCKOUT_HISTORY_SECONDS });
    await env.NJWG_KV.delete(failKey);
  } else {
    await env.NJWG_KV.put(failKey, String(failures), { expirationTtl: AUTH_FAILURE_WINDOW_SECONDS });
  }
}

// ---- Payload size limits (write / delete) ---------------------------------
//
// Nothing previously bounded how large a single write's row data (or how
// many match columns a write/delete specified) could be. A legitimate
// note or announcement body is at most a few KB of rich text; nothing in
// this app needs more. Capping it bounds both the Sheets API cost of an
// individual write and how much damage one runaway/malicious client can
// do in a single request — independent of the per-token rate limit, which
// only bounds how OFTEN a token can write, not how big each write is.

export const MAX_REQUEST_BODY_BYTES = 64 * 1024; // 64KB — generous for any real form on this app
const MAX_ROW_FIELDS = 60;
const MAX_FIELD_KEY_LENGTH = 100;
const MAX_FIELD_VALUE_LENGTH = 20000; // generous for a rich-text Notes/Announcements body
const MAX_MATCH_COLUMNS = 10;

/** Bounds the shape/size of a write's row data (or a delete's matchValues). */
export function assertReasonableRowPayload(rowData) {
  if (!rowData || typeof rowData !== "object") return;
  const keys = Object.keys(rowData);
  if (keys.length > MAX_ROW_FIELDS) {
    throw new Error(`Too many fields in row data (max ${MAX_ROW_FIELDS}).`);
  }
  for (const key of keys) {
    if (key.length > MAX_FIELD_KEY_LENGTH) {
      throw new Error("A field name is too long.");
    }
    const value = rowData[key];
    if (value !== null && value !== undefined && String(value).length > MAX_FIELD_VALUE_LENGTH) {
      throw new Error(`Field "${key}" is too long (max ${MAX_FIELD_VALUE_LENGTH} characters).`);
    }
  }
}

/** Bounds how many match columns a write/delete can specify. */
export function assertReasonableMatchColumns(matchColumns) {
  if (Array.isArray(matchColumns) && matchColumns.length > MAX_MATCH_COLUMNS) {
    throw new Error(`Too many match columns (max ${MAX_MATCH_COLUMNS}).`);
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
