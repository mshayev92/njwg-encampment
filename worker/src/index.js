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
  assertPageWriteAccess
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

  return respond({ ok: false, error: "Unknown or missing action for GET." });
}

async function handlePost(request, env, ctx) {
  const bodyText = await request.text();
  const body = JSON.parse(bodyText);

  if (body.action === "deviceLogin") {
    return respond(await handleDeviceLogin(env, body));
  }

  if (body.action === "login") {
    await requireDeviceToken(env, body.deviceToken);
    return respond(await handleLogin(env, body));
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

  return respond({ ok: false, error: "Unknown or missing action for POST." });
}

// ---- LOGIN / TOKENS ---------------------------------------------

async function handleDeviceLogin(env, body) {
  const passphrase = String(body.passphrase || "");
  const deviceType = body.deviceType === "shared" ? "shared" : "personal";

  await checkRateLimit(env, "deviceLogin");

  const attemptHash = await hashString(passphrase);
  const correctHash = env.PASSPHRASE_HASH;
  const success = attemptHash === correctHash;

  await logLoginAttempt(env, { type: "device", identifier: deviceType, success });

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

async function handleLogin(env, body) {
  const position = String(body.position || "").trim();
  if (!position) throw new Error("Select a position.");

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
      throw new Error("Incorrect password for that position.");
    }
  }

  await logLoginAttempt(env, { type: "session", identifier: position, success: true });

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

  await ensureAutoCreatedTab(env, sheetName);

  const headers = await getHeaderRow(env, sheetName);
  const rowData = body.row || {};

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
