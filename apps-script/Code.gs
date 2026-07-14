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
 *     A single long shared passphrase, given out to staff at check-in,
 *     unlocks a DEVICE. The passphrase is never compared in the browser
 *     — the backend only ever receives and checks a SHA-256 hash of it,
 *     and issues a signed, expiring "device token" on success.
 *
 *   LAYER 2 — PER-POSITION SESSION:
 *     No per-person login. Once a device is unlocked, the user picks a
 *     POSITION from a dropdown — a flight ("Alpha" through "Hotel"), a
 *     squadron ("Squadron 1" through "Squadron 4"), the Cadet Command
 *     Team ("CCT"), or "Administrator". CCT and Administrator each
 *     require their own password, stored as PLAINTEXT directly in the
 *     StaffAccess sheet's Password column (see "IMPORTANT SECURITY
 *     TRADEOFF" below). On success, a signed SESSION token is issued
 *     carrying {position, pages, flights}. Session tokens expire at
 *     local midnight.
 *
 *   PAGE ACCESS — EVERY PAGE IS GATED, NONE ARE AUTOMATIC:
 *     A position sees ONLY the pages listed in its own StaffAccess
 *     "Pages" column, including "roster", "overview", and
 *     "announcements" — nothing is automatic.
 *
 *   WRITE ACCESS TO Roster/Schedule/Announcements/BlackFlagStatus:
 *     Reading these sheets only requires an ordinary signed-in session
 *     (any position). WRITING to any of them requires the position's
 *     own Pages list to contain BOTH the page's normal view id (e.g.
 *     "schedule") AND a SEPARATE edit id (e.g. "edit-schedule") — see
 *     PAGE_WRITE_GATES. This means being able to SEE a page no longer
 *     implies being able to EDIT it: e.g. Pages = "schedule" is
 *     view-only, Pages = "schedule,edit-schedule" can also edit. Edit
 *     ids are scoped per-sheet (edit-roster, edit-schedule,
 *     edit-announcements are independent — a position can have any
 *     combination). UniformInspections stays write:"any" for any
 *     signed-in position, since every position that can reach
 *     Inspections needs to submit scorecards.
 *
 *   INSPECTION HISTORY:
 *     UniformInspections now supports MULTIPLE rows per student —
 *     writes match on the composite key (StudentCapId, Date), so
 *     re-inspecting the same student on a NEW day appends a fresh row
 *     instead of overwriting, while a second submission on the SAME
 *     day still updates in place. See matchColumns in handleWrite.
 *
 *   FLIGHT SCOPING (Inspections and Overview):
 *     The StaffAccess "Flights" column lists which flights a position
 *     may see stats for/inspect — blank or "all" means every flight.
 *     Does NOT restrict Roster.
 *
 *   ANNOUNCEMENTS & BLACK FLAG:
 *     Any position with "announcements" in its Pages can both read AND
 *     post announcements / toggle black flag status — there is no
 *     separate write-only distinction; access is controlled entirely by
 *     whether "announcements" appears in that position's Pages.
 *     Announcements live in an "Announcements" sheet tab; black flag
 *     status lives in a single row of a "BlackFlagStatus" tab (created
 *     automatically). Every page fetches both on load to power the
 *     header bell/banner — this uses the generic "read" action, so it
 *     requires only an ordinary signed-in session (any position), not
 *     specifically the announcements page permission, since the whole
 *     point is that the badge/banner shows up everywhere regardless of
 *     what pages a position can reach.
 *
 *   IMPORTANT SECURITY TRADEOFF — PLAINTEXT PASSWORDS IN THE SHEET:
 *     CCT and Administrator passwords are stored as PLAINTEXT in the
 *     StaffAccess tab's Password column. StaffAccess is deliberately
 *     EXCLUDED from ALLOWED_SHEETS so no page or generic API call can
 *     ever retrieve it — only handleLogin/handleListPositions touch it
 *     directly. The real boundary protecting these passwords is Google
 *     Sheet sharing permissions, not anything in this script.
 *
 * ONE-TIME SETUP:
 *   1. Paste this whole file into the Apps Script editor.
 *   2. Run `setupSecret` once.
 *   3. Decide your encampment passphrase and run `setPassphrase` ONCE.
 *   4. In StaffAccess, fill in Password for CCT/Administrator rows.
 *   5. Deploy > New deployment > Web app > Execute as: Me, Access: Anyone.
 *   6. Copy the /exec URL into js/config.js.
 *   7. Redeploy a NEW VERSION any time you edit this file.
 *
 * EXPECTED SHEET STRUCTURE:
 *   - "StaffAccess" tab: Position, Pages, Flights, Password
 *       Pages: comma-separated ids, e.g. "roster,schedule,inspections,
 *         overview,announcements" — matches NAV_ITEMS ids in
 *         js/config.js. Nothing is automatic. To ALSO grant edit
 *         access to Roster, Schedule, or Announcements/BlackFlag, add
 *         the matching "edit-roster", "edit-schedule", or
 *         "edit-announcements" id alongside the view id, e.g.
 *         "schedule,edit-schedule,roster,inspections" — the view id
 *         alone is view-only. Edit ids are independent of each other.
 *       Flights: comma-separated flight names, e.g. "Alpha,Bravo".
 *         Blank/"all" = every flight. Used by Inspections + Overview.
 *   - "Roster" tab: CapId, Name, Rank, Flight
 *   - "Schedule" tab: Day, Time, Activity, Location, Flight
 *   - "UniformInspections" tab: auto-created on first submission.
 *   - "Announcements" tab: auto-created on first post. Columns: Id,
 *       Timestamp, Position, Message.
 *   - "BlackFlagStatus" tab: auto-created on first toggle. A single
 *       data row: Active (TRUE/FALSE), UpdatedBy, UpdatedAt.
 *   - "LoginLog" tab: auto-created on first login attempt.
 * ============================================================
 */

// ---- CONFIG ----------------------------------------------------------

// StaffAccess is deliberately NOT in this list — see security tradeoff
// note above. Only handleLogin/handleListPositions may touch it.
const ALLOWED_SHEETS = [
  "Roster", "Schedule", "UniformInspections", "Announcements", "BlackFlagStatus"
];

// Positions that require a password, checked directly against the
// StaffAccess "Password" column. Matched case-insensitively.
const PASSWORD_PROTECTED_POSITIONS = ["cct", "administrator"];

// Device token lifetime after a correct passphrase entry.
const DEVICE_TOKEN_LIFETIME_HOURS_PERSONAL = 24 * 14; // ~2 weeks
const DEVICE_TOKEN_LIFETIME_HOURS_SHARED = 8;          // one duty day

// Per-sheet permission rules for the GENERIC read/write actions.
//   read/write: "any" | "none" | "page"
// "page" means: writable by any signed-in position, but ONLY if that
// position's own StaffAccess Pages column contains BOTH the sheet's
// view page id AND a separate edit page id (see PAGE_WRITE_GATES below
// and assertPageWriteAccess_) — seeing a page no longer implies being
// able to edit it.
const SHEET_PERMISSIONS = {
  Roster:             { read: "any", write: "page" },
  Schedule:           { read: "any", write: "page" },
  UniformInspections: { read: "any", write: "any" },
  Announcements:      { read: "any", write: "page" },
  BlackFlagStatus:    { read: "any", write: "page" }
};

// Which Pages-column id(s) gate writes to each "page"-permission sheet.
// Writing requires BOTH ids to be present in the position's Pages
// column: the VIEW page id (so you can't edit a page you can't even
// see) AND a separate EDIT id (so seeing a page no longer implies
// being able to edit it). Edit ids are scoped per-sheet on purpose —
// e.g. a position can have "edit-schedule" without "edit-roster" —
// rather than one all-or-nothing "edit" flag.
//   e.g. StaffAccess Pages = "schedule,edit-schedule" can view AND
//        edit Schedule; Pages = "schedule" (no edit id) can view but
//        NOT edit it.
const PAGE_WRITE_GATES = {
  Roster:          { viewPage: "roster",        editPage: "edit-roster" },
  Schedule:        { viewPage: "schedule",       editPage: "edit-schedule" },
  Announcements:   { viewPage: "announcements",  editPage: "edit-announcements" },
  BlackFlagStatus: { viewPage: "announcements",  editPage: "edit-announcements" }
};

// Max requests per token (or per login key) per rolling 60-second window.
const RATE_LIMIT_PER_MINUTE = 30;

// How long a sheet's full row data is cached (CacheService, shared across
// every user/instance of this script) before a read is forced to hit the
// Spreadsheet API again. Reads are the hot path — every page load warms
// several sheets, the header polls Announcements/BlackFlagStatus every 2
// minutes, and a manual Refresh re-reads everything currently on screen —
// so within this window, repeat reads of the same sheet (from different
// tabs/pages/background timers, or a Refresh click) are served out of
// cache instead of re-scanning and re-serializing the whole sheet each
// time. Writes invalidate the affected sheet's cache entry immediately
// (see invalidateSheetCache_), so nobody ever reads stale data past their
// own write.
const READ_CACHE_TTL_SECONDS = 20;

// Column order for auto-created tabs.
const UNIFORM_INSPECTION_COLUMNS = [
  "StudentCapId", "StudentName", "Flight", "InspectingPosition",
  "Date", "Timestamp",
  "Haircut", "CosmeticsOrShave", "CleanlinessPress", "ShirtTuck",
  "PatchesNametag", "InsigniaRibbons", "GigLine",
  "BootBlousingShoeShine", "MilitaryBearingCourtesy",
  "TotalPoints", "Notes"
];

const ANNOUNCEMENT_COLUMNS = ["Id", "Timestamp", "Position", "Message"];

const BLACK_FLAG_COLUMNS = ["RecordKey", "Active", "UpdatedBy", "UpdatedAt"];

// ---- ONE-TIME SETUP ----------------------------------------------------

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

function setPassphrase() {
  const PASSPHRASE = "";

  if (!PASSPHRASE) {
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

function isPasswordProtectedPosition_(position) {
  return PASSWORD_PROTECTED_POSITIONS.includes(String(position || "").trim().toLowerCase());
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

    if (action === "listPositions") {
      requireDeviceToken_(e.parameter.deviceToken);
      checkRateLimit_("listPositions:" + e.parameter.deviceToken);
      return respond(handleListPositions());
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

    if (body.action === "delete") {
      requireDeviceToken_(body.deviceToken);
      const session = requireSession_(body.token);
      checkRateLimit_(body.token);
      return respond(handleDelete(body, session));
    }

    return respond({ ok: false, error: "Unknown or missing action for POST." });
  } catch (err) {
    return respond({ ok: false, error: err.message });
  }
}

// ---- LOGIN / TOKENS ---------------------------------------------

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

function handleListPositions() {
  const sheet = getSheetOrThrow("StaffAccess");
  const values = sheet.getDataRange().getValues();
  if (values.length === 0) return { ok: true, positions: [] };

  const headers = values[0];
  const positionCol = headers.indexOf("Position");
  if (positionCol === -1) throw new Error("StaffAccess sheet is missing a Position column.");

  const positions = values.slice(1)
    .map((row) => String(row[positionCol] || "").trim())
    .filter(Boolean);

  return { ok: true, positions };
}

function handleLogin(body) {
  const position = String(body.position || "").trim();
  if (!position) throw new Error("Select a position.");

  checkRateLimit_("login:" + position);

  const sheet = getSheetOrThrow("StaffAccess");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const positionCol = headers.indexOf("Position");
  const pagesCol = headers.indexOf("Pages");
  const flightsCol = headers.indexOf("Flights");
  const passwordCol = headers.indexOf("Password");
  if (positionCol === -1) throw new Error("StaffAccess sheet is missing a Position column.");

  const matchRow = values.slice(1).find(
    (row) => String(row[positionCol]).trim().toLowerCase() === position.toLowerCase()
  );

  if (!matchRow) {
    logLoginAttempt_({ type: "session", identifier: position, success: false });
    throw new Error("That position isn't recognized. Check the list and try again.");
  }

  if (isPasswordProtectedPosition_(position)) {
    const storedPassword = passwordCol !== -1 ? String(matchRow[passwordCol] || "") : "";
    const submittedPassword = String(body.password || "");
    const passwordOk = !!storedPassword && submittedPassword === storedPassword;

    if (!passwordOk) {
      logLoginAttempt_({ type: "session", identifier: position, success: false });
      throw new Error("Incorrect password for that position.");
    }
  }

  logLoginAttempt_({ type: "session", identifier: position, success: true });

  const rawPages = pagesCol !== -1 ? String(matchRow[pagesCol] || "") : "";
  const pages = rawPages.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  const rawFlights = flightsCol !== -1 ? String(matchRow[flightsCol] || "") : "";
  const flights = rawFlights.split(",").map((f) => f.trim()).filter(Boolean);

  const member = { Position: position, Pages: pages, Flights: flights };

  const token = issueToken_(position, pages, flights);
  return { ok: true, token, member };
}

function issueToken_(position, pages, flights) {
  return issueGenericToken_({
    type: "session",
    position,
    pages: pages || [],
    flights: flights || [],
    exp: nextMidnight_().getTime()
  });
}

function nextMidnight_() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
}

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

function requireSession_(token) {
  const payload = verifyToken_(token);
  if (payload.type !== "session") throw new Error("Invalid session token. Please sign in again.");
  if (!payload.exp || Date.now() > payload.exp) {
    throw new Error("Session expired. Please sign in again.");
  }
  return payload;
}

// ---- LOGIN LOGGING -------------------------------------------------------

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
 * CacheService keys are capped at 250 characters — a raw session/device
 * token (which grows with the payload, e.g. more Pages/Flights entries)
 * can exceed that and throw "Argument too large: key". Hash the key
 * down to a fixed-length string first so rate limiting keeps working
 * regardless of how large tokens get.
 */
function checkRateLimit_(key) {
  if (!key) return;
  const cache = CacheService.getScriptCache();
  const cacheKey = "rl:" + hashString_(String(key));
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
  assertPermission_(sheetName, "read");

  if (sheetName === "UniformInspections") ensureSheetWithHeaders_("UniformInspections", UNIFORM_INSPECTION_COLUMNS);
  if (sheetName === "Announcements") ensureSheetWithHeaders_("Announcements", ANNOUNCEMENT_COLUMNS);
  if (sheetName === "BlackFlagStatus") ensureBlackFlagSheet_();

  const values = getCachedSheetValues_(sheetName);
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

  return { ok: true, rows };
}

/**
 * Cached read of a sheet's full getDataRange().getValues() — see
 * READ_CACHE_TTL_SECONDS above for why. Falls back to a direct read
 * whenever the cache misses, is empty, or the sheet is too large to fit
 * in a single CacheService entry (100KB/key limit) — in that last case
 * the put() below just silently no-ops via the try/catch, so oversized
 * sheets behave exactly as they did before this cache existed.
 */
function getCachedSheetValues_(sheetName) {
  const cache = CacheService.getScriptCache();
  const cacheKey = "sheetvals:" + sheetName;

  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (err) {
      // Fall through to a fresh read below.
    }
  }

  const sheet = getSheetOrThrow(sheetName);
  const values = sheet.getDataRange().getValues();

  try {
    cache.put(cacheKey, JSON.stringify(values), READ_CACHE_TTL_SECONDS);
  } catch (err) {
    // Too large for CacheService — just skip caching this sheet.
  }

  return values;
}

function invalidateSheetCache_(sheetName) {
  CacheService.getScriptCache().remove("sheetvals:" + sheetName);
}

// ---- WRITE ---------------------------------------------------------------

function handleWrite(body, session) {
  const sheetName = body.sheet;
  assertAllowedSheet(sheetName);
  assertPermission_(sheetName, "write");
  assertPageWriteAccess_(sheetName, session);

  if (sheetName === "UniformInspections") ensureSheetWithHeaders_("UniformInspections", UNIFORM_INSPECTION_COLUMNS);
  if (sheetName === "Announcements") ensureSheetWithHeaders_("Announcements", ANNOUNCEMENT_COLUMNS);
  if (sheetName === "BlackFlagStatus") ensureBlackFlagSheet_();

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

  // Composite match: if matchColumns (plural, array) is given, a row is
  // only considered "the same row" when ALL listed columns match. This
  // is what lets UniformInspections append a NEW row per (student, date)
  // instead of overwriting the student's only-ever scorecard — pass
  // matchColumns: ["StudentCapId", "Date"] to update the same day's
  // entry but still create a fresh row on a different day.
  // matchColumn (singular, string) still works as before for
  // Roster/Schedule/Announcements-style single-key matching.
  const matchColumns = Array.isArray(body.matchColumns) && body.matchColumns.length
    ? body.matchColumns
    : (body.matchColumn ? [body.matchColumn] : []);

  if (matchColumns.length && matchColumns.every((c) => headers.includes(c))) {
    const colIndexes = matchColumns.map((c) => headers.indexOf(c));
    const targetValues = colIndexes.map((ci) => String(rowData[headers[ci]]).trim().toLowerCase());

    for (let r = 1; r < values.length; r++) {
      const isMatch = colIndexes.every((ci, i) => String(values[r][ci]).trim().toLowerCase() === targetValues[i]);
      if (isMatch) {
        sheet.getRange(r + 1, 1, 1, newRowArray.length).setValues([newRowArray]);
        invalidateSheetCache_(sheetName);
        return { ok: true, action: "updated", row: rowData };
      }
    }
  }

  sheet.appendRow(newRowArray);
  invalidateSheetCache_(sheetName);
  return { ok: true, action: "appended", row: rowData };
}

/**
 * Deletes a row matched by matchColumn/matchColumns (same semantics as
 * handleWrite). Used for Roster removal. Requires the same page-gated
 * write permission as writing to that sheet.
 */
function handleDelete(body, session) {
  const sheetName = body.sheet;
  assertAllowedSheet(sheetName);
  assertPermission_(sheetName, "write");
  assertPageWriteAccess_(sheetName, session);

  const sheet = getSheetOrThrow(sheetName);
  const values = sheet.getDataRange().getValues();
  if (values.length === 0) throw new Error(`Sheet "${sheetName}" has no data.`);
  const headers = values[0];

  const matchColumns = Array.isArray(body.matchColumns) && body.matchColumns.length
    ? body.matchColumns
    : (body.matchColumn ? [body.matchColumn] : []);

  if (!matchColumns.length || !matchColumns.every((c) => headers.includes(c))) {
    throw new Error("Delete requires a valid matchColumn/matchColumns.");
  }

  const matchValues = body.matchValues || body.row || {};
  const colIndexes = matchColumns.map((c) => headers.indexOf(c));
  const targetValues = colIndexes.map((ci) => String(matchValues[headers[ci]]).trim().toLowerCase());

  for (let r = 1; r < values.length; r++) {
    const isMatch = colIndexes.every((ci, i) => String(values[r][ci]).trim().toLowerCase() === targetValues[i]);
    if (isMatch) {
      sheet.deleteRow(r + 1);
      invalidateSheetCache_(sheetName);
      return { ok: true, action: "deleted" };
    }
  }

  throw new Error("No matching row found to delete.");
}

/**
 * Generalized page-gated write check. Sheets whose SHEET_PERMISSIONS
 * write rule is "page" require the position's own Pages list (from its
 * StaffAccess row, carried on the session) to include BOTH:
 *   - the sheet's VIEW page id (e.g. "schedule") — can't edit a page
 *     you can't even see, and
 *   - the sheet's EDIT page id (e.g. "edit-schedule") — a separate,
 *     explicit grant, so having view access no longer implies edit
 *     access the way it used to.
 * Read access to these same sheets stays broader ("any" signed-in
 * position) — only writes are restricted. No-op for sheets not in
 * PAGE_WRITE_GATES.
 */
function assertPageWriteAccess_(sheetName, session) {
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

function ensureSheetWithHeaders_(sheetName, columns) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(columns);
  }
  return sheet;
}

/**
 * BlackFlagStatus is a single-row "settings" sheet rather than an
 * append-log — ensure exactly one data row exists, defaulting to
 * inactive, so reads never come back empty.
 */
function ensureBlackFlagSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("BlackFlagStatus");
  if (!sheet) {
    sheet = ss.insertSheet("BlackFlagStatus");
    sheet.appendRow(BLACK_FLAG_COLUMNS);
    sheet.appendRow(["singleton", false, "", ""]);
  }
  return sheet;
}

// ---- PERMISSIONS ---------------------------------------------------------

function assertPermission_(sheetName, mode) {
  const rules = SHEET_PERMISSIONS[sheetName];
  if (!rules) throw new Error(`No permission rule defined for "${sheetName}".`);

  const required = rules[mode];
  if (required === "none") throw new Error(`${mode} is not permitted on "${sheetName}".`);
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
