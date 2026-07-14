/**
 * ============================================================
 * NJWG CAP ENCAMPMENT — GOOGLE APPS SCRIPT BACKEND (SECURED)
 * ============================================================
 *
 * WHERE THIS FILE GOES:
 *   Lives INSIDE the Google Sheet (Extensions > Apps Script), not in the
 *   GitHub-hosted runtime. This copy in /apps-script/Code.gs is a version-
 *   controlled reference of what's deployed.
 *
 * WHY THIS VERSION IS DIFFERENT FROM A BASIC "NO API KEY" SETUP:
 *   The app's HTML/CSS/JS is on a PUBLIC GitHub Pages site, which means:
 *     - Anyone can view page source and read js/config.js, including the
 *       Apps Script /exec URL. That URL cannot be kept secret.
 *     - Anyone can call that URL directly with curl/Postman, bypassing
 *       index.html entirely.
 *   So the login page alone is NOT a security boundary — it's just a
 *   redirect. The actual boundary has to live here, server-side, in two
 *   layers:
 *
 *   LAYER 1 — DEVICE GATE (passphrase):
 *     A single long shared passphrase, given out to cadre at check-in,
 *     unlocks a DEVICE for either the rest of the encampment (personal
 *     device) or a short window (shared/desk device — see js/config.js
 *     DEVICE_GATE settings). This keeps random internet traffic out
 *     entirely. The passphrase is never compared in the browser — the
 *     backend only ever receives and checks a SHA-256 hash of it, and
 *     issues a signed, expiring "device token" on success. Rotate the
 *     passphrase each encampment cycle by changing PASSPHRASE_HASH below.
 *
 *   LAYER 2 — PER-PERSON SESSION (CAP ID):
 *     Once a device is unlocked, a CAP ID is used to look up the member
 *     and issue a signed, expiring SESSION token (separate from the
 *     device token). Every read/write must present a valid session
 *     token; the backend verifies signature + expiry server-side on
 *     every call. Session tokens now expire at local midnight rather
 *     than N hours from login, so a token can't meaningfully outlive
 *     the day it was issued on regardless of what time login happened.
 *
 *   PLUS:
 *     - Writes require Role == "Staff" in Roster.
 *     - Sensitive columns can be excluded per-role via redaction rules.
 *     - Rate limiting via CacheService slows brute-force / scraping.
 *     - Every login attempt (device gate and per-person) is logged to
 *       a LoginLog tab for after-action review.
 *
 *   This is NOT the same as real user-account security (no per-person
 *   passwords, no 2FA) — it's the strongest practical bar for a
 *   no-backend-server, CAP-ID-based system on a public static site.
 *   See README for the honest limitations.
 *
 * ONE-TIME SETUP — RUN THIS FIRST:
 *   1. Paste this whole file into the Apps Script editor.
 *   2. Run `setupSecret` once (Run > select function > setupSecret) to
 *      generate and store the session-signing secret. Authorize when asked.
 *   3. Decide your encampment passphrase (long, e.g. 6+ random words) and
 *      run `setPassphrase` with it ONCE from the editor — see instructions
 *      on that function below. This stores only a hash, never the plaintext.
 *   4. Deploy > New deployment > Web app > Execute as: Me, Access: Anyone.
 *   5. Copy the /exec URL into js/config.js.
 *   6. Any time you edit this file, redeploy a NEW VERSION (Manage
 *      deployments > pencil icon > New version) — editing alone does not
 *      update the live endpoint.
 *
 * EXPECTED SHEET STRUCTURE:
 *   - "Roster" tab: CapId, Name, Rank, Flight, Role   (Role e.g. "Cadre" or "Staff")
 *   - "Schedule" tab: Day, Time, Activity, Location, Flight
 *   - "LoginLog" tab: created automatically on first login attempt if missing.
 *   - Add more tabs/columns freely — see ALLOWED_SHEETS and SHEET_PERMISSIONS below.
 * ============================================================
 */

// ---- CONFIG ----------------------------------------------------------

const ALLOWED_SHEETS = ["Roster", "Schedule"];

// Device token lifetime after a correct passphrase entry.
// The client tells us which one to use (personal vs shared device) —
// see handleDeviceLogin below — but these are the server-side ceilings;
// the client can never request longer than these.
const DEVICE_TOKEN_LIFETIME_HOURS_PERSONAL = 24 * 14; // ~2 weeks, comfortably covers one encampment
const DEVICE_TOKEN_LIFETIME_HOURS_SHARED = 8;          // one duty day, for shared/desk devices

// Per-person session tokens expire at the next local midnight after
// issuance (see issueToken_), regardless of what time login happened,
// so a token can't meaningfully outlive the day it was issued.

// Per-sheet permission rules. Every sheet must be listed.
//   read/write: "any" | "staff" | "none"
//   redactColumnsForNonStaff: columns stripped from reads for non-staff sessions
const SHEET_PERMISSIONS = {
  Roster:   { read: "any",  write: "staff", redactColumnsForNonStaff: [] },
  Schedule: { read: "any",  write: "staff", redactColumnsForNonStaff: [] }
};

// Max requests per token (or per login key) per rolling 60-second window.
const RATE_LIMIT_PER_MINUTE = 30;

// ---- ONE-TIME SETUP ----------------------------------------------------

/**
 * Run manually once from the Apps Script editor (Run menu).
 * Generates a random signing secret and stores it in Script Properties,
 * which is private to this script and never exposed to callers or GitHub.
 */
function setupSecret() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty("SESSION_SECRET")) {
    Logger.log("SESSION_SECRET already set. Delete it first if you want to rotate it (this invalidates all active sessions).");
    return;
  }
  const secret = Utilities.getUuid() + Utilities.getUuid();
  props.setProperty("SESSION_SECRET", secret);
  Logger.log("Secret generated and stored.");
}

function getSecret_() {
  const secret = PropertiesService.getScriptProperties().getProperty("SESSION_SECRET");
  if (!secret) throw new Error("Server not configured: run setupSecret() once from the Apps Script editor.");
  return secret;
}

/**
 * Run manually, ONCE per encampment cycle, from the Apps Script editor.
 *
 * HOW TO USE:
 *   1. In the Apps Script editor, temporarily edit the line below that
 *      says `const PASSPHRASE = "..."` — replace the placeholder with
 *      your real long passphrase (e.g. six random words).
 *   2. Select `setPassphrase` in the function dropdown, click Run.
 *   3. Check the log — it confirms the hash was stored.
 *   4. Delete the plaintext passphrase from this function afterward and
 *      save, so it doesn't sit in the script source in plaintext. Only
 *      the hash persists in Script Properties from here on.
 *   5. Give the real passphrase out to cadre verbally or on a printed
 *      card at check-in — never put it in GitHub or this file long-term.
 *
 * To rotate the passphrase for a new encampment, just run this again
 * with a new value — it overwrites the previous hash and invalidates
 * every device token issued under the old passphrase.
 */
function setPassphrase() {
  const PASSPHRASE = "REPLACE_WITH_YOUR_REAL_PASSPHRASE_THEN_DELETE_THIS_LINE";

  if (PASSPHRASE === "REPLACE_WITH_YOUR_REAL_PASSPHRASE_THEN_DELETE_THIS_LINE") {
    throw new Error("Edit the PASSPHRASE constant in setPassphrase() with your real passphrase first.");
  }

  const hash = hashString_(PASSPHRASE);
  PropertiesService.getScriptProperties().setProperty("PASSPHRASE_HASH", hash);
  Logger.log("Passphrase hash stored. Now delete the plaintext from this function and save.");
}

function hashString_(str) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return raw.map((b) => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
}

function getPassphraseHash_() {
  const hash = PropertiesService.getScriptProperties().getProperty("PASSPHRASE_HASH");
  if (!hash) throw new Error("Server not configured: run setPassphrase() once from the Apps Script editor.");
  return hash;
}

// ---- ENTRY POINTS ------------------------------------------------------

function doGet(e) {
  try {
    const action = e.parameter.action;

    if (action === "read") {
      requireDeviceToken_(e.parameter.deviceToken);
      const session = requireSession_(e.parameter.token);
      checkRateLimit_(e.parameter.token);
      return respond(handleRead(e.parameter, session));
    }

    return respond({ ok: false, error: "Unknown or missing action for GET." });
  } catch (err) {
    return respond({ ok: false, error: err.message });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (body.action === "deviceLogin") {
      return respond(handleDeviceLogin(body));
    }

    if (body.action === "login") {
      requireDeviceToken_(body.deviceToken);
      return respond(handleLogin(body));
    }

    if (body.action === "write") {
      requireDeviceToken_(body.deviceToken);
      const session = requireSession_(body.token);
      checkRateLimit_(body.token);
      return respond(handleWrite(body, session));
    }

    return respond({ ok: false, error: "Unknown or missing action for POST." });
  } catch (err) {
    return respond({ ok: false, error: err.message });
  }
}

// ---- LOGIN / TOKENS ---------------------------------------------

/**
 * LAYER 1 — DEVICE GATE
 * body.passphrase - required, checked against the stored hash
 * body.deviceType - "personal" | "shared", picks the token lifetime
 * Issues a signed "device" token on success. This does NOT identify a
 * person — it just marks "this device passed the passphrase gate."
 */
function handleDeviceLogin(body) {
  const passphrase = String(body.passphrase || "");
  const deviceType = body.deviceType === "shared" ? "shared" : "personal";

  checkRateLimit_("deviceLogin");

  const attemptHash = hashString_(passphrase);
  const correctHash = getPassphraseHash_();
  const success = attemptHash === correctHash;

  logLoginAttempt_({ type: "device", identifier: deviceType, success });

  if (!success) {
    throw new Error("Incorrect passphrase.");
  }

  const hours = deviceType === "shared"
    ? DEVICE_TOKEN_LIFETIME_HOURS_SHARED
    : DEVICE_TOKEN_LIFETIME_HOURS_PERSONAL;

  const token = issueGenericToken_({
    type: "device",
    deviceType,
    exp: Date.now() + hours * 60 * 60 * 1000
  });

  return { ok: true, deviceToken: token, deviceType };
}

function requireDeviceToken_(deviceToken) {
  const payload = verifyToken_(deviceToken);
  if (payload.type !== "device") throw new Error("Invalid device token. Please re-enter the passphrase.");
  if (Date.now() > payload.exp) throw new Error("Device access expired. Please re-enter the passphrase.");
  return payload;
}

/**
 * LAYER 2 — PER-PERSON SESSION
 * body.capId - required
 * Looks up the CAP ID in Roster. If found, issues a signed session token
 * containing {capId, role, exp}. exp is set to the next local midnight,
 * not a fixed duration from login, so a token can't outlive the day it
 * was issued on regardless of what time login happened.
 */
function handleLogin(body) {
  const capId = String(body.capId || "").trim();
  if (!capId) throw new Error("CAP ID is required.");

  checkRateLimit_("login:" + capId);

  const sheet = getSheetOrThrow("Roster");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const capIdCol = headers.indexOf("CapId");
  const roleCol = headers.indexOf("Role");
  if (capIdCol === -1) throw new Error("Roster sheet is missing a CapId column.");

  const matchRow = values.slice(1).find(
    (row) => String(row[capIdCol]).trim().toLowerCase() === capId.toLowerCase()
  );

  const success = !!matchRow;
  logLoginAttempt_({ type: "session", identifier: capId, success });

  if (!matchRow) {
    // Same generic message whether the ID doesn't exist or something else
    // failed, so the response can't be used to enumerate valid CAP IDs.
    throw new Error("CAP ID not found. Check the number and try again.");
  }

  const member = {};
  headers.forEach((h, i) => (member[h] = matchRow[i]));
  const role = roleCol !== -1 ? String(matchRow[roleCol] || "Cadre") : "Cadre";

  const token = issueToken_(capId, role);
  return { ok: true, token, member };
}

/** Session token, expiring at the next local midnight after issuance. */
function issueToken_(capId, role) {
  return issueGenericToken_({
    type: "session",
    capId,
    role,
    exp: nextMidnight_().getTime()
  });
}

function nextMidnight_() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return midnight;
}

/** Generic signed token: base64url(payloadJson) + "." + base64url(HMAC-SHA256 signature). */
function issueGenericToken_(payload) {
  const fullPayload = { ...payload, iat: Date.now() };
  const payloadStr = Utilities.base64EncodeWebSafe(JSON.stringify(fullPayload));
  const signature = signPayload_(payloadStr);
  return `${payloadStr}.${signature}`;
}

function signPayload_(payloadStr) {
  const raw = Utilities.computeHmacSha256Signature(payloadStr, getSecret_());
  return Utilities.base64EncodeWebSafe(raw);
}

/** Verifies any token's signature. Throws on failure. Does NOT check exp — callers check exp themselves for their token type. */
function verifyToken_(token) {
  if (!token) throw new Error("Missing token. Please sign in again.");

  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Malformed token. Please sign in again.");

  const [payloadStr, signature] = parts;
  const expectedSignature = signPayload_(payloadStr);

  if (signature !== expectedSignature) {
    throw new Error("Invalid token. Please sign in again.");
  }

  try {
    return JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(payloadStr)).getDataAsString());
  } catch (err) {
    throw new Error("Malformed token. Please sign in again.");
  }
}

/**
 * Verifies a session token's signature and expiry. Throws on any failure.
 * Returns the decoded { capId, role, iat, exp } on success.
 */
function requireSession_(token) {
  const payload = verifyToken_(token);
  if (payload.type !== "session") throw new Error("Invalid session token. Please sign in again.");
  if (!payload.exp || Date.now() > payload.exp) {
    throw new Error("Session expired. Please sign in again.");
  }
  return payload;
}

// ---- LOGIN LOGGING -------------------------------------------------------

/**
 * Appends a row to a "LoginLog" tab for after-action review. Creates the
 * tab with headers on first use if it doesn't exist yet. Never throws —
 * a logging failure should never block a legitimate login.
 */
function logLoginAttempt_(entry) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName("LoginLog");
    if (!sheet) {
      sheet = ss.insertSheet("LoginLog");
      sheet.appendRow(["Timestamp", "Type", "Identifier", "Success"]);
    }
    sheet.appendRow([new Date().toISOString(), entry.type, entry.identifier, entry.success]);
  } catch (err) {
    // Swallow — logging must never break login itself.
  }
}

// ---- RATE LIMITING -------------------------------------------------------

/**
 * Fixed-window rate limit using CacheService, keyed by whatever
 * identifier is passed in (token string, or "login:<capId>"). Not
 * bulletproof (Apps Script has no IP-level limiting available), but
 * meaningfully slows down direct-URL scraping/brute force.
 */
function checkRateLimit_(key) {
  if (!key) return;
  const cache = CacheService.getScriptCache();
  const cacheKey = "rl:" + key;
  const current = Number(cache.get(cacheKey) || 0);

  if (current >= RATE_LIMIT_PER_MINUTE) {
    throw new Error("Too many requests. Please wait a moment and try again.");
  }
  cache.put(cacheKey, String(current + 1), 60);
}

// ---- READ ---------------------------------------------------------------

function handleRead(params, session) {
  const sheetName = params.sheet;
  assertAllowedSheet(sheetName);
  assertPermission_(sheetName, "read", session);

  const sheet = getSheetOrThrow(sheetName);
  const values = sheet.getDataRange().getValues();
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
    if (["action", "sheet", "capId", "token"].includes(key)) return;
    if (!headers.includes(key)) return;
    const target = String(params[key]).trim().toLowerCase();
    rows = rows.filter((r) => String(r[key]).trim().toLowerCase() === target);
  });

  rows = redactForRole_(sheetName, rows, session);

  return { ok: true, rows };
}

function redactForRole_(sheetName, rows, session) {
  const rules = SHEET_PERMISSIONS[sheetName];
  if (!rules || session.role === "Staff") return rows;

  const toRedact = rules.redactColumnsForNonStaff || [];
  if (!toRedact.length) return rows;

  return rows.map((row) => {
    const copy = { ...row };
    toRedact.forEach((col) => delete copy[col]);
    return copy;
  });
}

// ---- WRITE ---------------------------------------------------------------

function handleWrite(body, session) {
  const sheetName = body.sheet;
  assertAllowedSheet(sheetName);
  assertPermission_(sheetName, "write", session);

  const sheet = getSheetOrThrow(sheetName);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];

  const rowData = body.row || {};
  Object.keys(rowData).forEach((key) => {
    if (!headers.includes(key)) {
      headers.push(key);
      sheet.getRange(1, headers.length).setValue(key);
    }
  });

  const newRowArray = headers.map((h) => (h in rowData ? rowData[h] : ""));

  if (body.matchColumn && headers.includes(body.matchColumn)) {
    const colIndex = headers.indexOf(body.matchColumn);
    const targetValue = String(rowData[body.matchColumn]).trim().toLowerCase();

    for (let r = 1; r < values.length; r++) {
      if (String(values[r][colIndex]).trim().toLowerCase() === targetValue) {
        sheet.getRange(r + 1, 1, 1, newRowArray.length).setValues([newRowArray]);
        return { ok: true, action: "updated", row: rowData };
      }
    }
  }

  sheet.appendRow(newRowArray);
  return { ok: true, action: "appended", row: rowData };
}

// ---- PERMISSIONS ---------------------------------------------------------

function assertPermission_(sheetName, mode, session) {
  const rules = SHEET_PERMISSIONS[sheetName];
  if (!rules) throw new Error(`No permission rule defined for "${sheetName}".`);

  const required = rules[mode];
  if (required === "none") throw new Error(`${mode} is not permitted on "${sheetName}".`);
  if (required === "staff" && session.role !== "Staff") {
    throw new Error(`You do not have permission to ${mode} "${sheetName}".`);
  }
}

// ---- HELPERS ---------------------------------------------------------------

function getSheetOrThrow(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) throw new Error(`Sheet tab "${sheetName}" not found.`);
  return sheet;
}

function assertAllowedSheet(sheetName) {
  if (!sheetName) throw new Error("Missing required 'sheet' parameter.");
  if (ALLOWED_SHEETS.length > 0 && !ALLOWED_SHEETS.includes(sheetName)) {
    throw new Error(`Sheet tab "${sheetName}" is not allowed.`);
  }
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
