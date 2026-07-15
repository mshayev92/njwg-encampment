/**
 * NJWG CAP ENCAMPMENT — CLOUDFLARE WORKER BACKEND
 *
 * Replaces apps-script/Code.gs. Same action=read/write/delete/login/
 * deviceLogin/listPositions contract, so js/api.js needs no changes
 * beyond pointing APPS_SCRIPT_URL at this Worker's URL. Talks to the
 * Google Sheet via the Sheets API v4 (see sheets.js / googleAuth.js)
 * using a service account instead of running "as" the sheet owner
 * inside Apps Script.
 *
 * See worker/README.md for setup/deployment.
 */

import {
  UNIFORM_INSPECTION_COLUMNS, ROOM_INSPECTION_COLUMNS, ANNOUNCEMENT_COLUMNS, BLACK_FLAG_COLUMNS, NOTES_COLUMNS,
  DEVICE_TOKEN_LIFETIME_HOURS_PERSONAL, DEVICE_TOKEN_LIFETIME_HOURS_SHARED,
  hashString, issueGenericToken, requireDeviceToken, requireSession, nextMidnight,
  checkRateLimit, assertAllowedSheet, assertPermission,
  assertPageWriteAccess,
  getClientIp, assertNotLockedOut, checkAuthAttemptRate, recordAuthResult,
  MAX_REQUEST_BODY_BYTES, assertReasonableRowPayload, assertReasonableMatchColumns
} from "./auth.js";

import {
  ensureSheetExists, getHeaderRow, getColumnValues, setRow, setHeaderCell, appendRow, deleteRow, getAllValues
} from "./sheets.js";

import { getCachedSheetValues, invalidateSheetCache } from "./readCache.js";

import { sendPush } from "./webPush.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function respond(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (request.method === "GET") {
        return await handleGet(request, env);
      }
      if (request.method === "POST") {
        return await handlePost(request, env, ctx);
      }
      return respond({ ok: false, error: "Unsupported method." });
    } catch (err) {
      return respond({ ok: false, error: err.message });
    }
  }
};

async function handleGet(request, env) {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const action = params.action;

  if (action === "read") {
    await requireDeviceToken(env, params.deviceToken);
    const session = await requireSession(env, params.token);
    await checkRateLimit(env, params.token);
    return respond(await handleRead(env, params));
  }

  if (action === "listPositions") {
    await requireDeviceToken(env, params.deviceToken);
    await checkRateLimit(env, "listPositions:" + params.deviceToken);
    return respond(await handleListPositions(env));
  }

  if (action === "pushConfig") {
    await requireDeviceToken(env, params.deviceToken);
    await requireSession(env, params.token);
    await checkRateLimit(env, params.token);
    return respond(handlePushConfig(env));
  }

  if (action === "adminListStaffAccess") {
    await requireDeviceToken(env, params.deviceToken);
    const session = await requireSession(env, params.token);
    await checkRateLimit(env, params.token);
    assertAdmin(session);
    return respond(await handleAdminListStaffAccess(env));
  }

  if (action === "adminListLoginLog") {
    await requireDeviceToken(env, params.deviceToken);
    const session = await requireSession(env, params.token);
    await checkRateLimit(env, params.token);
    assertAdmin(session);
    return respond(await handleAdminListLoginLog(env, params));
  }

  return respond({ ok: false, error: "Unknown or missing action for GET." });
}

async function handlePost(request, env, ctx) {
  const bodyText = await request.text();
  // Reject oversized bodies before paying for JSON.parse or any downstream
  // Sheets API work — see MAX_REQUEST_BODY_BYTES in auth.js.
  if (bodyText.length > MAX_REQUEST_BODY_BYTES) {
    return respond({ ok: false, error: "Request body too large." });
  }
  const body = JSON.parse(bodyText);
  const ip = getClientIp(request);

  if (body.action === "deviceLogin") {
    return respond(await handleDeviceLogin(env, body, ip));
  }

  if (body.action === "login") {
    await requireDeviceToken(env, body.deviceToken);
    return respond(await handleLogin(env, body, ip));
  }

  if (body.action === "write") {
    await requireDeviceToken(env, body.deviceToken);
    const session = await requireSession(env, body.token);
    await checkRateLimit(env, body.token);
    return respond(await handleWrite(env, body, session, ctx));
  }

  if (body.action === "delete") {
    await requireDeviceToken(env, body.deviceToken);
    const session = await requireSession(env, body.token);
    await checkRateLimit(env, body.token);
    return respond(await handleDelete(env, body, session));
  }

  if (body.action === "savePushSubscription") {
    await requireDeviceToken(env, body.deviceToken);
    await requireSession(env, body.token);
    await checkRateLimit(env, body.token);
    return respond(await handleSavePushSubscription(env, body));
  }

  if (body.action === "adminSaveStaffAccess") {
    await requireDeviceToken(env, body.deviceToken);
    const session = await requireSession(env, body.token);
    await checkRateLimit(env, body.token);
    assertAdmin(session);
    return respond(await handleAdminSaveStaffAccess(env, body, session));
  }

  if (body.action === "adminDeleteStaffAccess") {
    await requireDeviceToken(env, body.deviceToken);
    const session = await requireSession(env, body.token);
    await checkRateLimit(env, body.token);
    assertAdmin(session);
    return respond(await handleAdminDeleteStaffAccess(env, body, session));
  }

  return respond({ ok: false, error: "Unknown or missing action for POST." });
}

// ---- LOGIN / TOKENS ---------------------------------------------

async function handleDeviceLogin(env, body, ip) {
  const passphrase = String(body.passphrase || "");
  const deviceType = body.deviceType === "shared" ? "shared" : "personal";

  // Per-IP guards come first (see auth.js): a locked-out or flooding IP
  // never even reaches the passphrase comparison below. The existing
  // global "deviceLogin" key stays as a secondary, shared soft cap.
  await assertNotLockedOut(env, ip);
  await checkAuthAttemptRate(env, ip);
  await checkRateLimit(env, "deviceLogin");

  const attemptHash = await hashString(passphrase);
  const correctHash = env.PASSPHRASE_HASH;
  const success = attemptHash === correctHash;

  await logLoginAttempt(env, { type: "device", identifier: deviceType, success });
  await recordAuthResult(env, ip, success);

  if (!success) throw new Error("Incorrect passphrase.");

  const hours = deviceType === "shared" ? DEVICE_TOKEN_LIFETIME_HOURS_SHARED : DEVICE_TOKEN_LIFETIME_HOURS_PERSONAL;
  const token = await issueGenericToken(env, {
    type: "device",
    deviceType,
    exp: Date.now() + hours * 60 * 60 * 1000
  });

  return { ok: true, deviceToken: token, deviceType };
}

async function handleListPositions(env) {
  const values = await getStaffAccessValues(env);
  if (values.length === 0) return { ok: true, positions: [], passwordProtected: [] };

  const headers = values[0];
  const positionCol = headers.indexOf("Position");
  const passwordCol = headers.indexOf("Password");
  if (positionCol === -1) throw new Error("StaffAccess sheet is missing a Position column.");

  const positions = [];
  const passwordProtected = [];
  values.slice(1).forEach((row) => {
    const name = String(row[positionCol] || "").trim();
    if (!name) return;
    positions.push(name);
    // Data-driven, NOT a hardcoded name list — any position with a
    // non-empty Password cell requires one, not just "CCT"/"Administrator"
    // by name. Only exposes WHICH positions are protected, never the
    // password value itself.
    if (passwordCol !== -1 && String(row[passwordCol] || "").trim()) passwordProtected.push(name);
  });
  return { ok: true, positions, passwordProtected };
}

async function handleLogin(env, body, ip) {
  const position = String(body.position || "").trim();
  if (!position) throw new Error("Select a position.");

  // Per-IP guards first — same reasoning as handleDeviceLogin. This is
  // where CCT/Administrator password guessing would otherwise be limited
  // only by the position-keyed "login:<position>" global counter, which
  // one attacker could exhaust to lock out everyone else trying to sign
  // in as that position during the same window.
  await assertNotLockedOut(env, ip);
  await checkAuthAttemptRate(env, ip);
  await checkRateLimit(env, "login:" + position);

  const values = await getStaffAccessValues(env);
  const headers = values[0] || [];
  const positionCol = headers.indexOf("Position");
  const pagesCol = headers.indexOf("Pages");
  const flightsCol = headers.indexOf("Flights");
  const passwordCol = headers.indexOf("Password");
  if (positionCol === -1) throw new Error("StaffAccess sheet is missing a Position column.");

  const matchRow = values.slice(1).find(
    (row) => String(row[positionCol]).trim().toLowerCase() === position.toLowerCase()
  );

  if (!matchRow) {
    await logLoginAttempt(env, { type: "session", identifier: position, success: false });
    await recordAuthResult(env, ip, false);
    throw new Error("That position isn't recognized. Check the list and try again.");
  }

  // Password-protected means THIS row's Password cell is actually
  // filled in — not a hardcoded "cct"/"administrator" name check, so any
  // position an admin assigns a password to in the sheet is enforced,
  // not just those two specific names.
  const storedPassword = passwordCol !== -1 ? String(matchRow[passwordCol] || "").trim() : "";
  if (storedPassword) {
    const submittedPassword = String(body.password || "");
    if (submittedPassword !== storedPassword) {
      await logLoginAttempt(env, { type: "session", identifier: position, success: false });
      await recordAuthResult(env, ip, false);
      throw new Error("Incorrect password for that position.");
    }
  }

  await logLoginAttempt(env, { type: "session", identifier: position, success: true });
  await recordAuthResult(env, ip, true);

  const rawPages = pagesCol !== -1 ? String(matchRow[pagesCol] || "") : "";
  const pages = rawPages.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  const rawFlights = flightsCol !== -1 ? String(matchRow[flightsCol] || "") : "";
  const flights = rawFlights.split(",").map((f) => f.trim()).filter(Boolean);

  const member = { Position: position, Pages: pages, Flights: flights };

  const token = await issueGenericToken(env, {
    type: "session",
    position,
    pages,
    flights,
    exp: nextMidnight().getTime()
  });

  return { ok: true, token, member };
}

// StaffAccess is deliberately not readable via the generic read action —
// only login/listPositions touch it, same boundary as Code.gs.
function getStaffAccessValues(env) {
  return getAllValues(env, "StaffAccess");
}

async function logLoginAttempt(env, entry) {
  try {
    await ensureSheetExists(env, "LoginLog", ["Timestamp", "Type", "Identifier", "Success"]);
    await appendRow(env, "LoginLog", [new Date().toISOString(), entry.type, entry.identifier, entry.success]);
  } catch (err) {
    // Swallow — logging must never break login itself.
  }
}

// ---- ADMIN (StaffAccess management + LoginLog viewer) -------------------
//
// These manage the very sheet that governs who can do what, so every one
// is gated TWICE: the client only shows the Admin page to a session whose
// Pages include "admin", and each action here re-checks the same thing
// server-side (assertAdmin) — the client gate is a convenience, this is
// the boundary. StaffAccess passwords are never sent to the client; only
// a hasPassword flag is. Bootstrapping the first admin is a one-time
// manual edit of the StaffAccess sheet (add "admin" to a position's Pages).

const STAFF_ACCESS_HEADERS = ["Position", "Pages", "Flights", "Password"];

function assertAdmin(session) {
  const pages = (Array.isArray(session.pages) ? session.pages : []).map((p) => String(p).toLowerCase());
  if (!pages.includes("admin")) {
    throw new Error("Administrator access required.");
  }
}

function splitList(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** position(lowercased) -> { position, pages[] } for the last-admin guard. */
function readStaffPagesMap(values) {
  const headers = values[0] || [];
  const posCol = headers.indexOf("Position");
  const pagesCol = headers.indexOf("Pages");
  const map = new Map();
  if (posCol === -1) return map;
  values.slice(1).forEach((row) => {
    const name = String(row[posCol] || "").trim();
    if (!name) return;
    const pages = pagesCol !== -1 ? splitList(row[pagesCol]).map((p) => p.toLowerCase()) : [];
    map.set(name.toLowerCase(), { position: name, pages });
  });
  return map;
}

function countAdmins(map) {
  let n = 0;
  for (const v of map.values()) if (v.pages.includes("admin")) n++;
  return n;
}

async function handleAdminListStaffAccess(env) {
  const values = await getStaffAccessValues(env);
  const headers = values[0] || [];
  const posCol = headers.indexOf("Position");
  const pagesCol = headers.indexOf("Pages");
  const flightsCol = headers.indexOf("Flights");
  const pwCol = headers.indexOf("Password");
  if (posCol === -1) return { ok: true, positions: [] };

  const positions = values.slice(1)
    .filter((row) => String(row[posCol] || "").trim())
    .map((row) => ({
      Position: String(row[posCol] || "").trim(),
      Pages: pagesCol !== -1 ? splitList(row[pagesCol]) : [],
      Flights: flightsCol !== -1 ? splitList(row[flightsCol]) : [],
      // Never expose the password itself — only whether one is set.
      hasPassword: pwCol !== -1 && !!String(row[pwCol] || "").trim()
    }));

  return { ok: true, positions };
}

async function handleAdminSaveStaffAccess(env, body, session) {
  const position = String(body.position || "").trim();
  if (!position) throw new Error("Position name is required.");

  const pages = (Array.isArray(body.pages) ? body.pages : [])
    .map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  const flights = (Array.isArray(body.flights) ? body.flights : [])
    .map((f) => String(f).trim()).filter(Boolean);

  // Make sure the sheet + its standard columns exist before writing.
  await ensureSheetExists(env, "StaffAccess", STAFF_ACCESS_HEADERS);
  let values = await getStaffAccessValues(env);
  let headers = (values[0] || []).slice();
  for (const col of STAFF_ACCESS_HEADERS) {
    if (!headers.includes(col)) {
      headers.push(col);
      await setHeaderCell(env, "StaffAccess", headers.length - 1, col);
    }
  }
  const posCol = headers.indexOf("Position");
  const pwCol = headers.indexOf("Password");

  // Locate an existing row for this position (case-insensitive).
  let rowNumber = 0;
  let existingRow = null;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][posCol] || "").trim().toLowerCase() === position.toLowerCase()) {
      rowNumber = i + 1; // 1-based sheet row (values[0] is row 1)
      existingRow = values[i];
      break;
    }
  }

  // Guard: this edit must not remove the last remaining admin.
  const map = readStaffPagesMap(values);
  map.set(position.toLowerCase(), { position, pages });
  if (countAdmins(map) === 0) {
    throw new Error("At least one position must keep Administrator (\"admin\") access.");
  }

  // Password: blank/omitted means keep the existing one; clearPassword
  // wipes it. The plaintext is never sent to the client, so we read the
  // current value from the sheet to preserve it on an ordinary edit.
  const existingPassword = existingRow && pwCol !== -1 ? String(existingRow[pwCol] || "") : "";
  const newPassword = body.clearPassword
    ? ""
    : (typeof body.password === "string" && body.password !== "" ? body.password : existingPassword);

  const rowData = {
    Position: position,
    Pages: pages.join(", "),
    Flights: flights.join(", "),
    Password: newPassword
  };
  // Preserve any other columns that already exist on an edited row.
  const rowArray = headers.map((h, i) => (h in rowData ? rowData[h] : (existingRow ? (existingRow[i] ?? "") : "")));

  if (rowNumber > 0) {
    await setRow(env, "StaffAccess", rowNumber, rowArray);
    return { ok: true, action: "updated", position };
  }
  await appendRow(env, "StaffAccess", rowArray);
  return { ok: true, action: "created", position };
}

async function handleAdminDeleteStaffAccess(env, body, session) {
  const position = String(body.position || "").trim();
  if (!position) throw new Error("Position is required.");

  if (position.toLowerCase() === String(session.position || "").trim().toLowerCase()) {
    throw new Error("You can't delete the position you're currently signed in as.");
  }

  const values = await getStaffAccessValues(env);
  const headers = values[0] || [];
  const posCol = headers.indexOf("Position");
  if (posCol === -1) throw new Error("StaffAccess sheet is missing a Position column.");

  const map = readStaffPagesMap(values);
  map.delete(position.toLowerCase());
  if (countAdmins(map) === 0) {
    throw new Error("Can't delete the last position with Administrator access.");
  }

  let rowNumber = 0;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][posCol] || "").trim().toLowerCase() === position.toLowerCase()) {
      rowNumber = i + 1;
      break;
    }
  }
  if (!rowNumber) throw new Error("Position not found.");

  await deleteRow(env, "StaffAccess", rowNumber);
  return { ok: true, action: "deleted", position };
}

async function handleAdminListLoginLog(env, params) {
  let values;
  try {
    values = await getAllValues(env, "LoginLog");
  } catch (err) {
    // Sheet doesn't exist yet (no logins recorded) — treat as empty.
    return { ok: true, entries: [], total: 0 };
  }
  if (values.length < 2) return { ok: true, entries: [], total: 0 };

  const headers = values[0];
  const rows = values.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = row[i]));
    return obj;
  });
  rows.reverse(); // newest first (LoginLog is appended chronologically)

  const limit = Math.min(Math.max(Number(params.limit) || 200, 1), 1000);
  return { ok: true, entries: rows.slice(0, limit), total: rows.length };
}

// ---- WEB PUSH ------------------------------------------------------------
//
// Subscriptions live in the same KV namespace under the "push:" prefix
// (keyed by a hash of the endpoint, so re-registering the same device is
// idempotent). Writes here are rare — once per device when a staffer
// enables alerts — so they don't meaningfully add to KV write volume.

const PUSH_KEY_PREFIX = "push:";
const PUSH_SUB_TTL_SECONDS = 90 * 24 * 60 * 60; // prune devices silent for ~90 days

function handlePushConfig(env) {
  const enabled = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
  return { ok: true, enabled, vapidPublicKey: enabled ? env.VAPID_PUBLIC_KEY : null };
}

async function handleSavePushSubscription(env, body) {
  const sub = body.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw new Error("Invalid push subscription.");
  }
  const key = PUSH_KEY_PREFIX + (await hashString(sub.endpoint));
  const stored = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
  await env.NJWG_KV.put(key, JSON.stringify(stored), { expirationTtl: PUSH_SUB_TTL_SECONDS });
  return { ok: true };
}

function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function isBlackFlagActive(row) {
  const v = row.Active;
  return v === true || v === "TRUE" || v === "true" || v === "1" || v === 1;
}

/**
 * Decides whether a write to Announcements / BlackFlagStatus warrants a
 * push, builds the payload, and fans it out in the background. Silent
 * no-op when push isn't configured or the sheet isn't a broadcast one.
 */
function maybeDispatchPush(env, ctx, sheetName, rowData, action) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;

  let payload = null;
  if (sheetName === "Announcements" && action === "appended") {
    const text = stripHtml(rowData.Message);
    payload = {
      title: "📣 New Announcement",
      body: `${rowData.Position ? rowData.Position + ": " : ""}${text}`.slice(0, 200) || "New announcement posted.",
      tag: "announcement",
      url: "pages/announcements.html"
    };
  } else if (sheetName === "BlackFlagStatus") {
    const active = isBlackFlagActive(rowData);
    payload = {
      title: active ? "⚑ Black Flag Activated" : "⚑ Black Flag Lifted",
      body: active
        ? "Outdoor activity is now restricted."
        : "Outdoor activity restrictions have been lifted.",
      tag: "blackflag",
      url: "pages/overview.html"
    };
  }

  if (!payload) return;
  const work = dispatchPush(env, payload);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(work);
}

async function dispatchPush(env, payload) {
  let cursor;
  do {
    const list = await env.NJWG_KV.list({ prefix: PUSH_KEY_PREFIX, cursor });
    for (const entry of list.keys) {
      const raw = await env.NJWG_KV.get(entry.name);
      if (!raw) continue;
      let sub;
      try { sub = JSON.parse(raw); } catch { continue; }
      try {
        const res = await sendPush(env, sub, payload);
        // 404/410 mean the subscription is permanently gone — prune it so
        // we stop paying to try (and to keep the list small).
        if (res.status === 404 || res.status === 410) {
          await env.NJWG_KV.delete(entry.name);
        }
      } catch (err) {
        // One unreachable endpoint shouldn't abort the whole fan-out.
      }
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
}

// ---- READ ---------------------------------------------------------------

async function handleRead(env, params) {
  const sheetName = params.sheet;
  assertAllowedSheet(sheetName);
  assertPermission(sheetName, "read");

  await ensureAutoCreatedTab(env, sheetName);

  const values = await getCachedSheetValues(env, sheetName);
  if (values.length === 0) return { ok: true, rows: [] };

  const headers = values[0];
  let rows = values.slice(1).map((row) => {
    const obj = {};
    headers.forEach((header, i) => (obj[header] = row[i]));
    return obj;
  });

  if (params.capId) {
    const target = String(params.capId).trim().toLowerCase();
    rows = rows.filter((r) => String(r.CapId).trim().toLowerCase() === target);
  }

  Object.keys(params).forEach((key) => {
    if (["action", "sheet", "capId", "token", "deviceToken"].includes(key)) return;
    if (!headers.includes(key)) return;
    const target = String(params[key]).trim().toLowerCase();
    rows = rows.filter((r) => String(r[key]).trim().toLowerCase() === target);
  });

  return { ok: true, rows };
}

// ---- WRITE ---------------------------------------------------------------

async function handleWrite(env, body, session, ctx) {
  const sheetName = body.sheet;
  assertAllowedSheet(sheetName);
  assertPermission(sheetName, "write");
  assertPageWriteAccess(sheetName, session);

  const rowData = body.row || {};
  assertReasonableRowPayload(rowData);
  assertReasonableMatchColumns(body.matchColumns);

  await ensureAutoCreatedTab(env, sheetName);

  const headers = await getHeaderRow(env, sheetName);

  for (const key of Object.keys(rowData)) {
    if (!headers.includes(key)) {
      headers.push(key);
      await setHeaderCell(env, sheetName, headers.length - 1, key);
    }
  }

  const newRowArray = headers.map((h) => (h in rowData ? rowData[h] : ""));

  const matchColumns = Array.isArray(body.matchColumns) && body.matchColumns.length
    ? body.matchColumns
    : (body.matchColumn ? [body.matchColumn] : []);

  let action = "appended";
  if (matchColumns.length && matchColumns.every((c) => headers.includes(c))) {
    const rowNumber = await findMatchingRowNumber(env, sheetName, headers, matchColumns, rowData);
    if (rowNumber > 0) {
      await setRow(env, sheetName, rowNumber, newRowArray);
      action = "updated";
    }
  }
  if (action === "appended") {
    await appendRow(env, sheetName, newRowArray);
  }
  await invalidateSheetCache(env, sheetName);

  // Fan out a Web Push alert for the two staff-facing broadcast sheets,
  // in the background so the write's own response isn't delayed by it.
  maybeDispatchPush(env, ctx, sheetName, rowData, action);

  return { ok: true, action, row: rowData };
}

async function handleDelete(env, body, session) {
  const sheetName = body.sheet;
  assertAllowedSheet(sheetName);
  assertPermission(sheetName, "write");
  assertPageWriteAccess(sheetName, session);

  assertReasonableRowPayload(body.matchValues || body.row);
  assertReasonableMatchColumns(body.matchColumns);

  const headers = await getHeaderRow(env, sheetName);
  if (headers.length === 0) throw new Error(`Sheet "${sheetName}" has no data.`);

  const matchColumns = Array.isArray(body.matchColumns) && body.matchColumns.length
    ? body.matchColumns
    : (body.matchColumn ? [body.matchColumn] : []);

  if (!matchColumns.length || !matchColumns.every((c) => headers.includes(c))) {
    throw new Error("Delete requires a valid matchColumn/matchColumns.");
  }

  const matchValues = body.matchValues || body.row || {};
  const rowNumber = await findMatchingRowNumber(env, sheetName, headers, matchColumns, matchValues);
  if (rowNumber > 0) {
    await deleteRow(env, sheetName, rowNumber);
    await invalidateSheetCache(env, sheetName);
    return { ok: true, action: "deleted" };
  }

  throw new Error("No matching row found to delete.");
}

/**
 * Returns the 1-based sheet row number of the first data row whose
 * match columns all equal matchSource's values, or 0 if none matches.
 * Reads only the narrow match columns, mirroring findMatchingRowNumber_
 * in the old Code.gs.
 */
async function findMatchingRowNumber(env, sheetName, headers, matchColumns, matchSource) {
  const colIndexes = matchColumns.map((c) => headers.indexOf(c));
  const targetValues = colIndexes.map((ci) => String(matchSource[headers[ci]]).trim().toLowerCase());

  const columns = await Promise.all(colIndexes.map((ci) => getColumnValues(env, sheetName, ci)));
  const numDataRows = Math.max(...columns.map((c) => c.length), 0);

  for (let r = 0; r < numDataRows; r++) {
    const isMatch = colIndexes.every((ci, i) => String(columns[i][r] ?? "").trim().toLowerCase() === targetValues[i]);
    if (isMatch) return r + 2;
  }
  return 0;
}

async function ensureAutoCreatedTab(env, sheetName) {
  if (sheetName === "UniformInspections") {
    await ensureSheetExists(env, "UniformInspections", UNIFORM_INSPECTION_COLUMNS);
  }
  if (sheetName === "RoomInspections") {
    await ensureSheetExists(env, "RoomInspections", ROOM_INSPECTION_COLUMNS);
  }
  if (sheetName === "Announcements") {
    await ensureSheetExists(env, "Announcements", ANNOUNCEMENT_COLUMNS);
  }
  if (sheetName === "BlackFlagStatus") {
    await ensureSheetExists(env, "BlackFlagStatus", BLACK_FLAG_COLUMNS, [["singleton", false, "", ""]]);
  }
  if (sheetName === "Notes") {
    await ensureSheetExists(env, "Notes", NOTES_COLUMNS);
  }
}
