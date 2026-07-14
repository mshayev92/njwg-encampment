/* ============================================================
   NJWG CAP ENCAMPMENT — GLOBAL CONFIG
   Edit this file to point the app at your Apps Script deployment.
   Every page loads this file before api.js.
   ============================================================ */

/**
 * Detects the site's base path at runtime so the app works whether it's
 * hosted at a domain root (https://example.com/) or in a GitHub Pages
 * project subfolder (https://username.github.io/repo-name/). Every
 * internal redirect (gate.html, index.html, nav links) is built from
 * this instead of a hardcoded leading slash, so moving the repo or
 * renaming it never breaks navigation.
 *
 * How it works: every HTML file in this project loads config.js from a
 * relative path ("js/config.js" from root pages, "../js/config.js" from
 * pages/). We reverse-engineer the site's base path from THIS script's
 * own <script> tag src, which is reliable regardless of how deep the
 * current page happens to be.
 */
window.APP_BASE_PATH = (() => {
  const scripts = document.getElementsByTagName("script");
  const thisScript = scripts[scripts.length - 1]; // config.js is always loaded first, synchronously
  const src = thisScript.getAttribute("src") || "";
  // src looks like "js/config.js" or "../js/config.js" — strip "js/config.js" off the end.
  const marker = "js/config.js";
  const idx = src.indexOf(marker);
  const relativePrefix = idx >= 0 ? src.slice(0, idx) : "";
  // Resolve that relative prefix against the CURRENT PAGE'S DIRECTORY
  // (not the full page URL, which would incorrectly include the page's
  // own filename when relativePrefix is empty) to get an absolute base
  // path like "/njwg-encampment/" or "/".
  const pageDir = window.location.href.slice(0, window.location.href.lastIndexOf("/") + 1);
  const resolved = new URL(relativePrefix, pageDir);
  return resolved.pathname;
})();

window.APP_CONFIG = {
  // Paste your Apps Script Web App URL here after deploying
  // (Deploy > New deployment > Web app > "Anyone" access).
  // It looks like: https://script.google.com/macros/s/AKfycb.../exec
  //
  // SECURITY NOTE: this URL is NOT a secret. Because the site is hosted
  // publicly, anyone can view source and read this value, and call it
  // directly. That's expected and accounted for — see apps-script/Code.gs,
  // which requires a signed session token (issued at login) on every
  // read/write, not just a CAP ID. Your Roster sheet needs a "Role"
  // column (e.g. "Staff" or "Cadre") for the backend's permission rules
  // to work — see SHEET_PERMISSIONS in Code.gs.
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/PASTE_YOUR_DEPLOYMENT_ID_HERE/exec",

  // First day of encampment, used by the duty strip to compute "DAY X OF Y".
  // Format: YYYY-MM-DD, in the encampment's local timezone.
  ENCAMPMENT_START_DATE: "2026-07-19",
  ENCAMPMENT_END_DATE: "2026-07-26",

  UNIT_NAME: "NJWG CAP Encampment",
  UNIT_SHORT: "NJWG",

  // sessionStorage key for the per-person session (CAP ID + token).
  // Cleared when the browser tab closes, or after IDLE_TIMEOUT_MINUTES
  // of inactivity — see js/auth.js.
  SESSION_KEY: "njwg_encampment_session",

  // localStorage key for the device gate (passphrase-unlocked device
  // token). Persists across browser restarts on purpose — see
  // js/auth.js and gate.html.
  DEVICE_KEY: "njwg_encampment_device",

  // Minutes of inactivity before the PER-PERSON session (not the device
  // gate) auto-clears, requiring CAP ID re-entry. Keeps a device that's
  // left logged in and unattended from staying "signed in as that
  // person" indefinitely. Does not affect the device gate itself.
  IDLE_TIMEOUT_MINUTES: 120,

  // NAV_ITEMS hrefs are relative to APP_BASE_PATH, not the domain root —
  // Shell.js resolves them at render time via Shell's nav renderer.
  NAV_ITEMS: [
    { id: "schedule", label: "Schedule", href: "pages/schedule.html", icon: "calendar" },
    { id: "roster",   label: "Roster",   href: "pages/roster.html",   icon: "users" }
    // Add future pages here, e.g.:
    // { id: "forms", label: "Forms", href: "pages/forms.html", icon: "file" },
  ]
};
