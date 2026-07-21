/* ============================================================
   NJWG ENCAMPMENT — GLOBAL CONFIG
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
  // Backend base URL — despite the name, this now points at the
  // Cloudflare Worker in worker/ (deployed from worker/src/index.js),
  // NOT apps-script/Code.gs. The Worker implements the identical
  // action=read/write/delete/login/deviceLogin/listPositions contract
  // against the same Google Sheet (via the Sheets API + a service
  // account instead of running inside Apps Script), so js/api.js and
  // every page needed zero changes for this switch. Key name kept as
  // APPS_SCRIPT_URL rather than renamed, since every page/script
  // references window.APP_CONFIG.APPS_SCRIPT_URL.
  //
  // SECURITY NOTE: this URL is NOT a secret. Because the site is hosted
  // publicly, anyone can view source and read this value, and call it
  // directly. That's expected and accounted for — the backend requires
  // a signed session token (issued at login) on every read/write.
  // Permissions live in the StaffAccess tab's Pages column (per-position
  // view/edit grants), not on the Roster — see SHEET_PERMISSIONS and
  // PAGE_WRITE_GATES in worker/src/auth.js.
  //
  // MUST be the deployed Worker's HTTPS URL in production. A plain-HTTP or
  // localhost value (e.g. the `wrangler dev` default http://127.0.0.1:8787)
  // is blocked as mixed content on the HTTPS GitHub Pages site and is
  // unreachable for real users — only use it for local development, and
  // never commit it. For local dev, point this at your `wrangler dev` URL
  // temporarily but revert before pushing.
  APPS_SCRIPT_URL: "https://njwg-encampment-api.njwg-encampment-1.workers.dev",

  // First day of encampment, used by the duty strip to compute "DAY X OF Y".
  // Format: YYYY-MM-DD, in the encampment's local timezone.
  ENCAMPMENT_START_DATE: "2026-07-25",
  ENCAMPMENT_END_DATE: "2026-08-01",

  UNIT_NAME: "NJWG Encampment",
  UNIT_SHORT: "NJWG",

  // localStorage key for the per-position session (position + token).
  // Persists across browser/PWA restarts, same as DEVICE_KEY below, so a
  // device that's already signed in can keep working (including fully
  // offline) after being relaunched — cleared only by explicit logout or
  // after IDLE_TIMEOUT_MINUTES of inactivity, not by closing the app —
  // see js/auth.js.
  SESSION_KEY: "njwg_encampment_session",

  // localStorage key for the device gate (passphrase-unlocked device
  // token). Persists across browser restarts on purpose — see
  // js/auth.js and gate.html.
  DEVICE_KEY: "njwg_encampment_device",

  // Minutes of inactivity before the PER-PERSON session (not the device
  // gate) auto-clears, requiring a position to be re-selected. This is
  // what keeps a device left logged in and unattended from staying
  // "signed in as that position" indefinitely — now the ONLY thing that
  // does, since the session itself persists across an app close/relaunch
  // (see SESSION_KEY above). Does not affect the device gate itself.
  IDLE_TIMEOUT_MINUTES: 120,

  // Fixed encampment location for the Overview page's weather widget
  // (Joint Base McGuire-Dix-Lakehurst, NJ) — not the device's location.
  WEATHER_LOCATION_NAME: "JB McGuire-Dix-Lakehurst, NJ",
  WEATHER_LAT: 40.0156,
  WEATHER_LON: -74.5917,

  // NAV_ITEMS hrefs are relative to APP_BASE_PATH, not the domain root —
  // Shell.js resolves them at render time via Shell's nav renderer.
  NAV_ITEMS: [
    { id: "overview",     label: "Overview",     href: "pages/overview.html",     icon: "grid" },
    { id: "schedule",     label: "Schedule",     href: "pages/schedule.html",     icon: "calendar" },
    { id: "roster",       label: "Roster",       href: "pages/roster.html",       icon: "users" },
    { id: "inspections",  label: "Inspections",  href: "pages/inspections.html",  icon: "check" },
    { id: "observations", label: "Observations", href: "pages/observations.html", icon: "star" },
    { id: "recommendations", label: "Awards", href: "pages/recommendations.html", icon: "award" },
    { id: "notes",        label: "Notes",        href: "pages/notes.html",        icon: "edit" },
    { id: "announcements", label: "Announcements", href: "pages/announcements.html", icon: "file" },
    // Administrator-only: gated by the "admin" page token (server-enforced
    // too). Only positions granted "admin" in their StaffAccess Pages see it.
    { id: "admin", label: "Admin", href: "pages/admin.html", icon: "shield" }
    // Add future pages here, e.g.:
    // { id: "forms", label: "Forms", href: "pages/forms.html", icon: "file" },
  ],

  // Every sheet any page reads from, warmed in the background on every
  // page load (see Shell.init -> Api.warmCache) so navigating to a page
  // you haven't visited yet still renders instantly from cache instead
  // of waiting on the network. Add a sheet here whenever a new page
  // starts reading from one.
  //
  // BlackFlagStatus is deliberately absent — the Black Flag UI (Overview's
  // weather-card banner, the header pill, Announcements' toggle card, the
  // notification-feed entry) was removed from the frontend pending a
  // future pass; nothing here reads that sheet anymore. The Worker/sheet
  // side (worker/src/index.js, worker/src/auth.js) is untouched and still
  // fully functional — see the comments there.
  PREFETCH_SHEETS: ["Roster", "Schedule", "UniformInspections", "RoomInspections", "PTInspections", "InspectionPeriods", "PhysicalAssessments", "Announcements", "Notes", "Observations", "HonorCadetRecommendations", "HonorFlightRecommendations", "FlightStandingsWeights"],

  // Which sheets each page actually reads. Used to warm ONLY the sheets a
  // signed-in position could actually reach (see accessiblePrefetchSheets_
  // in js/shell.js), instead of every sheet in PREFETCH_SHEETS — a flight
  // position without the "recommendations" page never warms the Honor*
  // sheets, cutting background reads/Worker invocations for that device.
  // Keys are NAV_ITEMS ids; a page absent here contributes no sheets.
  // When a new page starts reading a sheet, add it here too.
  PAGE_SHEETS: {
    overview:        ["Roster", "Schedule", "UniformInspections", "RoomInspections", "PTInspections", "InspectionPeriods", "PhysicalAssessments", "Observations", "FlightStandingsWeights"],
    schedule:        ["Schedule"],
    roster:          ["Roster"],
    inspections:     ["Roster", "UniformInspections", "RoomInspections", "PTInspections", "InspectionPeriods", "PhysicalAssessments"],
    observations:    ["Roster", "Observations"],
    recommendations: ["Roster", "HonorCadetRecommendations", "HonorFlightRecommendations", "UniformInspections", "RoomInspections", "PhysicalAssessments", "Observations"],
    notes:           ["Roster", "Notes"],
    announcements:   ["Announcements"],
    admin:           ["Roster"]
  },

  // NOTE: Announcements / Notes — the header's notification bell feed,
  // shown on EVERY page regardless of which pages a position is granted —
  // are kept warm by loadGlobalAlerts_ in js/shell.js on its own
  // independent poll, not by PAGE_SHEETS/warmCache below. There's
  // deliberately no GLOBAL_SHEETS entry here for
  // Shell.accessiblePrefetchSheets_ to also warm them through warmCache;
  // doing both used to fetch the same sheets twice. (BlackFlagStatus used
  // to be a third source here too — see the PREFETCH_SHEETS comment above.)

  // Squadrons have no cadets of their own — they're a grouping of
  // flights. There's no sheet/column anywhere that records this
  // membership, so it lives here: a Schedule item (or anything else)
  // audienced to "Squadron 1" is visible to every flight listed under
  // it (see Shell.flightMatchesAudience, used by the Schedule/Overview
  // "happening now" banner and the Notes/Inspections/Overview visibility
  // checks). Keys are lowercased squadron names; only Squadron 1 is
  // filled in below from a confirmed example — ADD THE REST to match
  // your actual squadron structure.
  SQUADRON_FLIGHTS: {
    "squadron 1": ["Alpha", "Bravo"]
    // "squadron 2": ["Charlie", "Delta"],
    // "squadron 3": ["Echo", "Foxtrot"],
    // "squadron 4": ["Golf", "Hotel"],
  },

  // FALLBACK per-flight accent color — used in Overview's Flight
  // Standings bars and Today's Inspections breakdown, the flight tiles
  // on Roster/Inspections/Observations, and Schedule's audience badge
  // (see Shell.flightColor). This is NOT the primary source anymore: an
  // Administrator can sync the REAL colors straight from the Roster
  // sheet's Flight column (Admin -> Worker Settings -> "Sync from
  // Roster"), which reads the actual cell background color of each
  // flight's rows — that's what actually shows up once it's been run at
  // least once. This static palette only matters BEFORE that first sync
  // (or if the synced-colors fetch fails on a given page load) — edit it
  // if you want a specific look before ever running the sync, but don't
  // expect editing it to override an already-synced color. Keys are
  // lowercased flight names; any flight name not listed here still gets
  // a color — Shell.flightColor falls back to a deterministic (but not
  // editable) hue derived from the name itself, so a squadron or a
  // custom flight name is never left uncolored, just not exactly tunable.
  FLIGHT_COLORS: {
    alpha:   "#2563eb",
    bravo:   "#dc2626",
    charlie: "#16a34a",
    delta:   "#d97706",
    echo:    "#7c3aed",
    foxtrot: "#0891b2",
    golf:    "#db2777",
    hotel:   "#65a30d"
  }
};
