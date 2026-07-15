/**
 * Thin wrapper over the Google Sheets API v4, using the access token
 * from googleAuth.js. Mirrors the shape of operations apps-script/Code.gs
 * used to do via the SpreadsheetApp service — getDataRange/appendRow/
 * getRange/setValues/deleteRow — but over HTTP, and (for writes) reading
 * only the narrow ranges actually needed instead of the whole sheet.
 */

import { getAccessToken } from "./googleAuth.js";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

async function sheetsFetch(env, path, options = {}) {
  const accessToken = await getAccessToken(env);
  const response = await fetch(`${SHEETS_API}/${env.SPREADSHEET_ID}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Sheets API error ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function colIndexToLetter(index) {
  // 0-based column index -> A1 column letters ("A", "B", ..., "AA", ...)
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

// ---- Spreadsheet metadata (sheet name -> numeric sheetId) --------------
//
// Row deletion via batchUpdate's deleteDimension needs the sheet's
// numeric gid, not its name. This rarely changes, so it's cached in KV
// briefly to avoid an extra API round-trip on every write/delete.

const META_CACHE_KEY = "sheetmeta";
const META_CACHE_TTL_SECONDS = 300;

async function getSpreadsheetMeta(env) {
  const cached = await env.NJWG_KV.get(META_CACHE_KEY, "json");
  if (cached) return cached;

  const data = await sheetsFetch(env, "?fields=sheets.properties");
  const meta = {};
  (data.sheets || []).forEach((s) => {
    meta[s.properties.title] = s.properties.sheetId;
  });

  await env.NJWG_KV.put(META_CACHE_KEY, JSON.stringify(meta), { expirationTtl: META_CACHE_TTL_SECONDS });
  return meta;
}

function invalidateMeta(env) {
  return env.NJWG_KV.delete(META_CACHE_KEY);
}

/**
 * Ensures a tab with the given name exists, creating it (with the given
 * header row) if not. Mirrors ensureSheetWithHeaders_ in the old
 * Code.gs, used for the auto-created UniformInspections/Announcements/
 * BlackFlagStatus tabs.
 */
export async function ensureSheetExists(env, sheetName, headerColumns, extraRows = []) {
  const meta = await getSpreadsheetMeta(env);
  if (sheetName in meta) return;

  await sheetsFetch(env, ":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: sheetName } } }]
    })
  });
  await invalidateMeta(env);

  await setRow(env, sheetName, 1, headerColumns);
  for (let i = 0; i < extraRows.length; i++) {
    await setRow(env, sheetName, i + 2, extraRows[i]);
  }
}

// ---- Reads ---------------------------------------------------------------

/** Full getDataRange().getValues() equivalent — used for handleRead. */
export async function getAllValues(env, sheetName) {
  const data = await sheetsFetch(env, `/values/${encodeURIComponent(sheetName)}`);
  return data.values || [];
}

/** Just the header row (row 1). */
export async function getHeaderRow(env, sheetName) {
  const data = await sheetsFetch(env, `/values/${encodeURIComponent(sheetName)}!1:1`);
  return (data.values && data.values[0]) || [];
}

/**
 * Reads a single column's data rows (everything below the header) as a
 * flat array. Used to locate a matching row for update/delete without
 * pulling the whole grid — the same optimization made in Code.gs's
 * findMatchingRowNumber_.
 */
export async function getColumnValues(env, sheetName, colIndex) {
  const colLetter = colIndexToLetter(colIndex);
  const data = await sheetsFetch(env, `/values/${encodeURIComponent(sheetName)}!${colLetter}2:${colLetter}`);
  return (data.values || []).map((row) => (row.length ? row[0] : ""));
}

// ---- Writes ----------------------------------------------------------------

/** Overwrites one full row (1-based row number) with the given array of values. */
export async function setRow(env, sheetName, rowNumber, rowArray) {
  const lastColLetter = colIndexToLetter(Math.max(rowArray.length - 1, 0));
  const range = `${encodeURIComponent(sheetName)}!A${rowNumber}:${lastColLetter}${rowNumber}`;
  await sheetsFetch(env, `/values/${range}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ range, values: [rowArray] })
  });
}

/** Sets a single header cell — used when a write introduces a brand-new column. */
export async function setHeaderCell(env, sheetName, colIndex, value) {
  const colLetter = colIndexToLetter(colIndex);
  const range = `${encodeURIComponent(sheetName)}!${colLetter}1`;
  await sheetsFetch(env, `/values/${range}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ range, values: [[value]] })
  });
}

/** Appends a row after the last row with data — equivalent to sheet.appendRow(). */
export async function appendRow(env, sheetName, rowArray) {
  await sheetsFetch(
    env,
    `/values/${encodeURIComponent(sheetName)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      body: JSON.stringify({ values: [rowArray] })
    }
  );
}

/** Deletes a single row (1-based sheet row number) — equivalent to sheet.deleteRow(). */
export async function deleteRow(env, sheetName, rowNumber) {
  const meta = await getSpreadsheetMeta(env);
  const sheetId = meta[sheetName];
  if (sheetId === undefined) throw new Error(`Sheet tab "${sheetName}" not found.`);

  await sheetsFetch(env, ":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: rowNumber - 1,
            endIndex: rowNumber
          }
        }
      }]
    })
  });
}
