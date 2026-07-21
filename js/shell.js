/* ============================================================
   NJWG ENCAMPMENT — APP SHELL RENDERER
   Builds the header, nav rail, and announcements bell. Every page
   includes a skeleton like:

     <div class="app-shell">
       <nav class="nav-rail" id="nav-rail"></nav>
       <header class="app-header" id="app-header"></header>
       <main class="app-main">...page content...</main>
     </div>
     <script src="js/config.js"></script>   (or "../js/config.js" from pages/)
     <script src="js/api.js"></script>
     <script src="js/auth.js"></script>
     <script src="js/shell.js"></script>
     <script>Shell.init({ activePage: 'schedule' }); </script>

   PAGE ACCESS:
   Every page is gated — there is no always-allowed page, including
   Roster. Each signed-in position's session carries a Pages array
   (from the StaffAccess sheet tab) listing exactly which nav items
   it's allowed to see.

   ANNOUNCEMENTS / BLACK FLAG:
   Shown on EVERY page regardless of whether that position has the
   "announcements" page itself — reading is open to any signed-in
   position (see Code.gs), only posting/toggling is restricted to
   positions with "announcements" in their Pages. The bell tracks a
   per-device "last seen" timestamp in localStorage so the badge count
   reflects only announcements posted since this device last opened
   the bell — this is a per-device convenience, not a security feature.

   PERFORMANCE / SYNC STATUS:
   The header shows a live sync indicator (queued/syncing/synced/error)
   driven by Api.onSyncStatusChange — see js/api.js for the optimistic
   write model this reflects. Shell.confirm() renders a themed modal in
   place of the browser's native confirm() (which can't be restyled);
   Shell.tooltip() wires a themed hover/focus bubble in place of the
   native title="" tooltip. Shell.hardRefresh() is what the dedicated
   Refresh button in each page should call — it clears the read cache
   and re-runs that page's own load(), guaranteeing nothing stale is
   shown, as opposed to the automatic instant-cached-render every page
   does on normal load.
   ============================================================ */

const Shell = (() => {
  const ICONS = {
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    users:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    file:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    check:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
    bell:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    edit:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
    refresh:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 15.3-6.4L21 8M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16M3 21v-5h5"/></svg>',
    search:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
    bellPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-9.9-4.5"/><path d="M6 8c0 7-3 9-3 9h13"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18 3v6M15 6h6"/></svg>',
    shield:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    clock:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    grid:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    star:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2.5l2.9 6.06 6.6.85-4.85 4.6 1.28 6.6L12 17.5l-5.93 3.11 1.28-6.6-4.85-4.6 6.6-.85z"/></svg>',
    award:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="6"/><path d="M8.5 13.5L7 22l5-3 5 3-1.5-8.5"/></svg>',
    // A device outline with a "+" — distinct from `download` (the CSV
    // export tray-arrow), reads as "add this app to your device."
    install:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="3"/><path d="M12 8v6M9 11h6"/><path d="M11 18h2"/></svg>',
    sun:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
    moon:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    monitor:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    printer:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
    upload:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>',
    // Hamburger — the mobile nav drawer's trigger (see
    // #mobile-nav-toggle-btn in renderHeader), replacing the bottom tab
    // bar on narrow/phone viewports (portrait, or landscape).
    menu:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>'
  };

  // All of these used to be single GLOBAL localStorage keys, shared by
  // every position that ever signed in on a given device. That meant a
  // shared/testing device switching from Position A to Position B could
  // silently suppress the popup for something Position B had never
  // actually seen — Position A's session already advanced the SAME
  // stored "last known" baseline past it. Every one of these is now
  // suffixed per-position (see positionScopedKey_ below) so each
  // position signed in on a device tracks its own baseline, while still
  // persisting across restarts (unlike sessionStorage, which would lose
  // the baseline on every browser close and re-alert the whole backlog).
  const ANNOUNCEMENTS_SEEN_KEY_PREFIX = "njwg_announcements_last_seen_at_";
  const NOTES_SEEN_KEY_PREFIX = "njwg_notes_last_seen_at_";
  const NAV_COLLAPSED_KEY = "njwg_nav_collapsed";
  // Tracks what THIS position already knows about, independent of the
  // "last seen" bell/notifications timestamp above — used only to detect
  // a genuinely NEW announcement/note-to-me since the last poll (on any
  // page), so the blocking alert popup fires once per new arrival
  // instead of replaying the whole backlog on every page load. (A third
  // key here used to track Black Flag's own "signature" the same way,
  // backing a checkBlackFlagChange_ function right after
  // checkNewAnnouncements_ below — both removed from the frontend
  // pending a future pass.)
  const LAST_KNOWN_ANNOUNCEMENT_TS_KEY_PREFIX = "njwg_last_known_announcement_ts_";
  const LAST_KNOWN_NOTE_TS_KEY_PREFIX = "njwg_last_known_note_ts_";

  function positionScopedKey_(prefix) {
    const session = Auth.getSession();
    const position = session && session.Position ? String(session.Position).trim().toLowerCase() : "anonymous";
    return prefix + position;
  }

  /**
   * Escapes a value for safe interpolation into innerHTML — both element
   * text and quoted attribute values. Every page renders sheet-sourced
   * data (names, activities, announcement text, flight names) via
   * template strings into innerHTML; without escaping, an ordinary
   * ampersand or angle bracket in that data (e.g. a cadet named
   * "Smith & Jones" or an announcement reading "a < b") renders wrong or
   * vanishes, and free-text fields become an injection vector. Use this
   * on ANY dynamic value going into markup. Exposed as Shell.escapeHtml.
   */
  function escapeHtml_(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Formats a timestamp for display in 24-hour time everywhere in the
   * app, regardless of the device's locale/OS setting — several
   * browsers/OSes default to 12-hour AM/PM, which reads ambiguously for
   * a military encampment schedule. Exposed as Shell.formatDateTime /
   * Shell.formatTime; use these instead of raw toLocaleString() /
   * toLocaleTimeString() for anything shown to a person.
   */
  function formatDateTime_(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
      year: "numeric", month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false
    });
  }

  function formatTime_(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  /** "just now" / "5m ago" / "3h ago" / "2d ago" for a past ms-since-epoch timestamp. Used by the header's "Data updated" tooltip. */
  function formatRelativeTime_(atMs) {
    const seconds = Math.max(0, Math.round((Date.now() - atMs) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }

  // Set once by init() — lets nav rendering (and anything else that
  // cares) know which page is currently showing without threading the
  // value through every function signature.
  let activePage_ = null;

  /** Returns the list of NAV_ITEMS ids this session is allowed to see. */
  function getAllowedPageIds() {
    const session = Auth.getSession();
    const pages = (session && Array.isArray(session.Pages)) ? session.Pages : [];
    return new Set(pages.map((p) => String(p).toLowerCase()));
  }

  function getAllowedNavItems() {
    const allowedSet = getAllowedPageIds();
    return window.APP_CONFIG.NAV_ITEMS.filter((item) => allowedSet.has(item.id.toLowerCase()));
  }

  /**
   * The set of sheets worth warming for THIS position via Api.warmCache:
   * every sheet read by a page it's actually allowed to see
   * (APP_CONFIG.PAGE_SHEETS). This is what's handed to Api.warmCache
   * instead of the full PREFETCH_SHEETS, so a position never spends
   * background reads warming sheets behind pages it can't open. Falls
   * back to the full PREFETCH_SHEETS if PAGE_SHEETS isn't configured, so
   * nothing regresses.
   *
   * Deliberately does NOT seed GLOBAL_SHEETS (Announcements/Notes) —
   * those are already kept warm independently by loadGlobalAlerts_'s own
   * poll (see Shell.init), on every page regardless of access. Seeding
   * them here too used to mean the same sheets were fetched twice on
   * overlapping schedules: once via this function's batchRead warm, once
   * via loadGlobalAlerts_'s individual reads.
   */
  function accessiblePrefetchSheets_() {
    const cfg = window.APP_CONFIG || {};
    const pageSheets = cfg.PAGE_SHEETS || {};
    if (!Object.keys(pageSheets).length) return cfg.PREFETCH_SHEETS || [];

    const allowed = getAllowedPageIds();
    const set = new Set();
    Object.keys(pageSheets).forEach((pageId) => {
      if (allowed.has(pageId.toLowerCase())) {
        (pageSheets[pageId] || []).forEach((sheet) => set.add(sheet));
      }
    });
    return Array.from(set);
  }

  function isNavCollapsed_() {
    return localStorage.getItem(NAV_COLLAPSED_KEY) === "true";
  }

  function applyCollapsedState_(collapsed) {
    const shell = document.querySelector(".app-shell");
    if (shell) shell.classList.toggle("app-shell--collapsed", collapsed);
    // Keep the <html> class an inline anti-FOUC script sets at first
    // paint (see .nav-rail-collapsed in css/app.css) in sync with the
    // LIVE toggle too — otherwise it stays stuck at whatever it was on
    // page load and its CSS rule (which targets <html>, so it never
    // reacts to the .app-shell--collapsed class above) keeps forcing
    // the collapsed width even after the crest button expands the rail.
    document.documentElement.classList.toggle("nav-rail-collapsed", collapsed);
  }

  function toggleNavCollapsed_() {
    const collapsed = !isNavCollapsed_();
    localStorage.setItem(NAV_COLLAPSED_KEY, String(collapsed));
    applyCollapsedState_(collapsed);
  }

  // ---- Theme (light / dark / system) ----
  // Same "flat, device-level, not position-scoped" precedent as
  // NAV_COLLAPSED_KEY above (a visual-chrome preference belongs to the
  // device, not whoever's currently signed into it). THEME_PREF is what
  // the person picked — "light" | "dark" | "system"; THEME_RESOLVED is
  // never itself stored, it's always recomputed from THEME_PREF (+ the
  // OS setting, when THEME_PREF is "system") and written to
  // <html data-theme="...">, which is what every dark: token override in
  // css/tokens.css actually keys off. Every page also carries an
  // identical synchronous inline script in <head>, BEFORE tokens.css/
  // app.css load (see index.html/gate.html/offline.html and each
  // pages/*.html) that does this same resolution at first paint — this
  // module's job is to keep that in sync with live changes (the person
  // toggling the menu, or the OS theme flipping under a "system" pref)
  // for the rest of the page's life, not the first paint itself.
  const THEME_KEY = "njwg_theme";
  let darkMediaQuery_ = null;

  function getThemePreference_() {
    const v = localStorage.getItem(THEME_KEY);
    return (v === "light" || v === "dark") ? v : "system";
  }

  function systemPrefersDark_() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function resolveTheme_(pref) {
    return pref === "system" ? (systemPrefersDark_() ? "dark" : "light") : pref;
  }

  /** Applies `pref` to <html> + the mobile theme-color/status-bar meta, and refreshes the toggle button/menu if the header's currently on screen. Does NOT persist — see setThemePreference_ for that. */
  function applyTheme_(pref) {
    const resolved = resolveTheme_(pref);
    document.documentElement.setAttribute("data-theme", resolved);
    // The address-bar/status-bar tint on mobile — matches --bg (the
    // actual page background, see tokens.css) for whichever theme is
    // resolved, instead of a value that only ever matched ONE theme.
    // This used to hardcode "#0d1250" (the brand indigo) for light mode
    // specifically — which is the nav rail's color, not light mode's
    // actual (much lighter) page background — so a light-theme device's
    // status bar always read as a dark indigo strip sitting on top of a
    // visibly lighter page underneath it.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", resolved === "dark" ? "#080a38" : "#f4f5fa");
    // iOS PWA (standalone launch) status bar style — "black" forces a
    // solid dark bar regardless of page content, which is exactly the
    // same light-theme mismatch as above; "default" gives light mode
    // its normal light bar with dark icons/clock instead.
    const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (statusBarMeta) statusBarMeta.setAttribute("content", resolved === "dark" ? "black" : "default");
    updateThemeMenuUI_(pref, resolved);
  }

  function setThemePreference_(pref) {
    localStorage.setItem(THEME_KEY, pref);
    applyTheme_(pref);
  }

  /**
   * Registers the live OS-theme-change listener once per page load —
   * only matters for a "system" preference, so a person who's left the
   * app open sees it follow their OS switching (say, at sunset) without
   * needing to reload. Explicit "light"/"dark" prefs ignore this
   * entirely, on purpose — they've opted OUT of following the system.
   */
  function initThemeWatcher_() {
    applyTheme_(getThemePreference_());
    if (!window.matchMedia || darkMediaQuery_) return;
    darkMediaQuery_ = window.matchMedia("(prefers-color-scheme: dark)");
    darkMediaQuery_.addEventListener("change", () => {
      if (getThemePreference_() === "system") applyTheme_("system");
    });
  }

  /**
   * The crest button (icon + unit name) is pre-rendered statically in
   * each page's own HTML now, not generated here — see the markup right
   * inside #nav-rail in any page. It used to be built into the same
   * innerHTML blast as the nav links below, which meant the crest
   * image was torn down and recreated from scratch on every single
   * page load (this is a static multi-page app, so THAT happens on
   * every tab switch), producing a visible pop/reload of the icon each
   * time even though the image bytes were already cached. Rendering it
   * statically means it's part of the very first paint, identical
   * every navigation, and never gets touched again — renderNav() below
   * only wires its click handler and fills in the links/footer below
   * it, it doesn't recreate it.
   */
  // Tracks whether renderNav() already ran for this page load (see
  // renderNavEarly_ below) — Shell.init()'s own renderNav(activePage)
  // call is skipped when it would just be an identical, wasted re-render
  // moments after the early one already painted the same links.
  let navRenderedForPage_ = null;

  function renderNav(activePage) {
    navRenderedForPage_ = activePage;
    const rail = document.getElementById("nav-rail");
    if (!rail) return;

    // Fall back to the crest's old JS-rendered behavior if a page
    // hasn't been updated with the static markup for some reason, so
    // this never silently renders an empty rail.
    const linksContainer = document.getElementById("nav-rail-links") || rail;
    // Scrollable list of links ONLY — the footer card below is a sibling
    // of this element (not inside it), so it never scrolls out of view
    // along with the links (see .nav-rail__links in css/app.css).
    linksContainer.classList.add("nav-rail__links");

    const links = getAllowedNavItems().map(item => `
      <a class="nav-rail__link" href="${window.APP_BASE_PATH}${item.href}" ${item.id === activePage ? 'aria-current="page"' : ''}>
        <span class="nav-rail__link-icon">${ICONS[item.icon] || ""}</span>
        <span class="nav-rail__link-label">${item.label}</span>
        ${item.id === "notes" ? `<span id="notes-nav-badge" style="display:none; position:absolute; top:6px; left:28px; background:var(--red-600); color:#fff; border-radius:999px; font-size:10px; line-height:1; padding:3px 5px; font-family:var(--font-mono);"></span>` : ""}
      </a>
    `).join("");

    linksContainer.innerHTML = links;

    // On the mobile bottom tab bar the links scroll horizontally when there
    // are more than fit (see the max-width:720px rules in app.css). Make
    // sure the CURRENT page's tab is scrolled into view so it's never sitting
    // off the end of the bar. Guarded to the mobile bar so it never nudges
    // the vertical desktop/tablet rail. `inline: "center"` scrolls only the
    // links container (which is the horizontal scroll parent); "nearest"
    // block avoids any vertical page jump.
    if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(max-width: 720px)").matches) {
      const activeLink = linksContainer.querySelector('.nav-rail__link[aria-current="page"]');
      if (activeLink && activeLink.scrollIntoView) {
        activeLink.scrollIntoView({ inline: "center", block: "nearest" });
      }
    }

    applyCollapsedState_(isNavCollapsed_());

    const crestBtn = document.getElementById("nav-rail-crest");
    if (crestBtn) {
      crestBtn.addEventListener("click", () => {
        // Collapsing to icons-only is a desktop affordance; inside the
        // mobile drawer the crest is pure branding (see the CSS forcing
        // the unit name/divider to stay visible there regardless of
        // collapsed state) — toggling the preference from a tap here
        // used to still fire, which is what visibly blanked the unit
        // name for an instant (the collapsed state's opacity/width
        // transition briefly applying before this same breakpoint's
        // override caught up). Checked live at click time (not just
        // once at render) so it stays correct across a rotation too.
        if (typeof window !== "undefined" && window.matchMedia && window.matchMedia(MOBILE_PORTRAIT_QUERY).matches) return;
        toggleNavCollapsed_();
      });
    }
  }

  function renderHeader(activePage) {
    const header = document.getElementById("app-header");
    if (!header) return;

    const session = Auth.getSession();
    const navItem = (window.APP_CONFIG.NAV_ITEMS || []).find(i => i.id === activePage);
    const title = navItem ? navItem.label : window.APP_CONFIG.UNIT_NAME;

    const positionLabel = session ? (session.Position || session.position || "Staff") : "";

    header.innerHTML = `
      ${session ? `
        <button class="btn btn--ghost" id="mobile-nav-toggle-btn" aria-haspopup="true" aria-expanded="false" aria-label="Open navigation menu" style="padding: var(--space-2);">
          <span style="width:20px;height:20px;display:inline-flex;">${ICONS.menu}</span>
        </button>
      ` : ""}
      <h1 class="app-header__title">${title}</h1>
      <div class="app-header__user">
        ${session ? `
          <span id="sync-indicator" class="sync-indicator sync-indicator--synced" data-tooltip="Data updated: just now">
            <span class="sync-indicator__dot"></span>
            <span id="sync-indicator__label">Synced</span>
          </span>
          <button class="btn btn--ghost" id="global-search-btn" data-tooltip="Search (Ctrl+K / ⌘+K)" aria-label="Search" style="padding: var(--space-2);">
            <span style="width:18px;height:18px;display:inline-flex;">${ICONS.search}</span>
          </button>
          <div class="theme-menu-wrap" id="theme-menu-wrap">
            <button class="btn btn--ghost" id="theme-menu-btn" aria-haspopup="true" aria-expanded="false" data-tooltip="Theme" aria-label="Theme" style="padding: var(--space-2);">
              <span id="theme-menu-icon" style="width:18px;height:18px;display:inline-flex;"></span>
            </button>
            <div class="theme-menu" id="theme-menu" hidden>
              <button class="theme-menu__item" id="theme-option-light" data-theme-pref="light">
                <span class="theme-menu__item-icon">${ICONS.sun}</span>
                <span>Light</span>
                <span class="theme-menu__item-check">${ICONS.check}</span>
              </button>
              <button class="theme-menu__item" id="theme-option-dark" data-theme-pref="dark">
                <span class="theme-menu__item-icon">${ICONS.moon}</span>
                <span>Dark</span>
                <span class="theme-menu__item-check">${ICONS.check}</span>
              </button>
              <button class="theme-menu__item" id="theme-option-system" data-theme-pref="system">
                <span class="theme-menu__item-icon">${ICONS.monitor}</span>
                <span>System</span>
                <span class="theme-menu__item-check">${ICONS.check}</span>
              </button>
            </div>
          </div>
          <button class="btn btn--ghost app-header__bell" id="announcements-bell-btn" style="position: relative; padding: var(--space-2);" data-tooltip="Notifications" aria-label="Notifications">
            <span style="width:18px;height:18px;display:inline-flex;">${ICONS.bell}</span>
            <span id="announcements-badge" style="display:none; position:absolute; top:2px; right:2px; background:var(--red-600); color:#fff; border-radius:999px; font-size:10px; line-height:1; padding:3px 5px; font-family:var(--font-mono);"></span>
          </button>
          <div class="profile-menu-wrap">
            <button class="btn btn--ghost profile-menu__trigger" id="profile-menu-btn" aria-haspopup="true" aria-expanded="false" data-tooltip="Account">
              <span class="profile-menu__label">${escapeHtml_(positionLabel)}</span>
            </button>
            <div class="profile-menu" id="profile-menu" hidden>
              <!-- Empty (and hidden via CSS :empty) except in mobile
                   portrait, where relocateHeaderPillsForViewport_ below
                   moves the sync indicator/search/theme/notifications out
                   of .app-header__user and in here, so the always-visible
                   header row stays just the nav toggle, the page title,
                   and this profile tab. -->
              <div class="profile-menu__quick-row" id="profile-menu-quick-row"></div>
              <button class="profile-menu__item" id="hard-refresh-btn" data-tooltip="Refresh all data now">
                <span class="spinner spinner--sm btn__spinner" id="hard-refresh-spinner" style="display:none;"></span>
                <span class="profile-menu__item-icon hard-refresh-icon" aria-hidden="true">${ICONS.refresh}</span>
                <span id="hard-refresh-label">Refresh</span>
              </button>
              <button class="profile-menu__item" id="export-btn" style="display:none;">
                <span class="profile-menu__item-icon">${ICONS.download}</span>
                <span>Export CSV</span>
              </button>
              <button class="profile-menu__item" id="print-btn">
                <span class="profile-menu__item-icon">${ICONS.printer}</span>
                <span>Print</span>
              </button>
              <button class="profile-menu__item" id="pwa-install-btn" style="display:none;">
                <span class="profile-menu__item-icon">${ICONS.install}</span>
                <span>Install app</span>
              </button>
              <button class="profile-menu__item" id="push-enable-btn" style="display:none;">
                <span class="profile-menu__item-icon">${ICONS.bellPlus}</span>
                <span>Enable alerts</span>
              </button>
              <div class="profile-menu__divider"></div>
              <button class="profile-menu__item profile-menu__item--danger" id="logout-btn">
                <span>Log out</span>
              </button>
            </div>
          </div>
        ` : ""}
      </div>
    `;

    const bellBtn = document.getElementById("announcements-bell-btn");
    if (bellBtn) {
      // Always opens the popover now, rather than navigating to the
      // Announcements page when one exists — the popover is a merged
      // feed (Announcements + Notes sent to me), which the standalone
      // Announcements page doesn't show.
      bellBtn.addEventListener("click", () => {
        markAnnouncementsSeen_();
        toggleAnnouncementsPopover_();
      });
    }

    const hardRefreshBtn = document.getElementById("hard-refresh-btn");
    if (hardRefreshBtn) {
      hardRefreshBtn.addEventListener("click", () => { closeProfileMenu_(); hardRefresh(); });
    }

    const searchBtn = document.getElementById("global-search-btn");
    if (searchBtn) searchBtn.addEventListener("click", () => openSearch_());

    const exportBtn = document.getElementById("export-btn");
    if (exportBtn) {
      exportBtn.addEventListener("click", () => { closeProfileMenu_(); runExport_(); });
      // A page may have registered its export before the header was
      // (re)rendered — reflect that here so the button shows immediately.
      if (exportConfig_) exportBtn.style.display = "flex";
    }

    // Deliberately unconditional (no per-page registration, unlike
    // Export) — the print stylesheet in css/app.css hides everything
    // interactive and prints whatever's currently on screen, which is a
    // reasonable default on every page, not just a few that opt in.
    const printBtn = document.getElementById("print-btn");
    if (printBtn) printBtn.addEventListener("click", () => { closeProfileMenu_(); window.print(); });

    const pushBtn = document.getElementById("push-enable-btn");
    if (pushBtn) pushBtn.addEventListener("click", () => { closeProfileMenu_(); enablePush_(); });

    const installBtn = document.getElementById("pwa-install-btn");
    if (installBtn) {
      installBtn.addEventListener("click", () => { closeProfileMenu_(); promptInstall_(); });
      // A page may have finished capturing the install prompt (or
      // detected iOS) before the header was (re)rendered — reflect that
      // here so the button shows immediately instead of waiting for the
      // next beforeinstallprompt/appinstalled event to fire again.
      if (canOfferInstall_()) installBtn.style.display = "flex";
    }

    const logoutBtn = document.getElementById("logout-btn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        closeProfileMenu_();
        // Logging back in needs a live connection (session issuing hits
        // the Worker), unlike everything else in this app, which keeps
        // working offline on whatever's already cached — so a position
        // that logs out without realizing that is locked out of the app
        // entirely until it's back online, not just stuck with stale
        // data. Confirming first (with that consequence spelled out)
        // costs nothing and prevents an accidental tap from doing this.
        const confirmed = await confirmDialog({
          title: "Log out?",
          message: "You'll need an internet connection to log back in.",
          confirmLabel: "Log out"
        });
        if (confirmed) Auth.logout();
      });
    }

    wireProfileMenu_();
    wireThemeMenu_();
    updateThemeMenuUI_(getThemePreference_(), resolveTheme_(getThemePreference_()));
    wireSyncIndicator_();
    wireTooltips_(header);
    wireMobileNavDrawer_();
    relocateHeaderPillsForViewport_();
  }

  // ---- Profile menu (top-right — replaces the old nav-rail "signed in
  // as" footer card). Holds Refresh/Export/Install/Enable-alerts/Log out
  // behind the position-name button so the always-visible header row
  // stays just the sync indicator, search, and notifications bell. ----

  let profileMenuOutsideHandler_ = null;
  let profileMenuKeyHandler_ = null;

  function closeProfileMenu_() {
    const menu = document.getElementById("profile-menu");
    const btn = document.getElementById("profile-menu-btn");
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (profileMenuOutsideHandler_) {
      document.removeEventListener("mousedown", profileMenuOutsideHandler_, true);
      profileMenuOutsideHandler_ = null;
    }
    if (profileMenuKeyHandler_) {
      document.removeEventListener("keydown", profileMenuKeyHandler_);
      profileMenuKeyHandler_ = null;
    }
  }

  function toggleProfileMenu_() {
    const menu = document.getElementById("profile-menu");
    const btn = document.getElementById("profile-menu-btn");
    if (!menu || !btn) return;
    if (!menu.hidden) { closeProfileMenu_(); return; }

    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");

    profileMenuOutsideHandler_ = (e) => {
      if (menu.contains(e.target) || btn.contains(e.target)) return;
      closeProfileMenu_();
    };
    profileMenuKeyHandler_ = (e) => { if (e.key === "Escape") closeProfileMenu_(); };
    // Wire on the next tick so the same click that opened the menu (which
    // bubbles to document) doesn't immediately close it again.
    setTimeout(() => {
      document.addEventListener("mousedown", profileMenuOutsideHandler_, true);
      document.addEventListener("keydown", profileMenuKeyHandler_);
    }, 0);
  }

  function wireProfileMenu_() {
    const btn = document.getElementById("profile-menu-btn");
    if (btn) btn.addEventListener("click", () => toggleProfileMenu_());
  }

  // ---- Mobile header layout ----
  //
  // On a phone — portrait, or landscape (see the matching CSS media
  // query in css/app.css, which also catches a landscape phone by its
  // short height rather than orientation) — the header keeps only the
  // nav toggle, the page title, and the profile tab on one row; the
  // sync indicator, search, theme, and notifications live in the
  // profile dropdown instead of their own always-visible row.
  // Everywhere else (desktop, tablet) they stay right where they've
  // always been, in .app-header__user next to the profile tab. Rather
  // than rendering two copies (duplicate ids/listeners), the SAME
  // elements are moved between the two containers with plain DOM
  // appendChild — cheap, and every element keeps its own event listeners
  // and popover positioning logic (the notifications popover and theme
  // menu both work out wherever their trigger currently sits on screen)
  // with no extra code.
  const MOBILE_PORTRAIT_QUERY = "(max-width: 1024px)";
  const HEADER_QUICK_ROW_IDS = ["sync-indicator", "global-search-btn", "theme-menu-wrap", "announcements-bell-btn"];
  let mobilePortraitMql_ = null;

  function relocateHeaderPillsForViewport_() {
    const quickRow = document.getElementById("profile-menu-quick-row");
    const userCluster = document.querySelector(".app-header__user");
    const profileWrap = document.querySelector(".profile-menu-wrap");
    if (!quickRow || !userCluster || !profileWrap) return;

    const isMobilePortrait = typeof window !== "undefined" && window.matchMedia && window.matchMedia(MOBILE_PORTRAIT_QUERY).matches;
    const target = isMobilePortrait ? quickRow : userCluster;
    // Re-insert each element right before the profile tab when it's
    // headed back to .app-header__user, preserving the original
    // sync/search/theme/bell -> profile-tab order — appendChild alone
    // would append after profile-menu-wrap instead.
    HEADER_QUICK_ROW_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (isMobilePortrait) target.appendChild(el);
      else userCluster.insertBefore(el, profileWrap);
    });

    // Listen for the breakpoint actually changing (e.g. rotating the
    // device, or resizing a desktop browser window) so this stays
    // correct for the rest of the page's life, not just at load —
    // registered once per page (renderHeader only runs once), removing
    // any previous listener first in case this is ever called again.
    if (!mobilePortraitMql_) {
      mobilePortraitMql_ = window.matchMedia(MOBILE_PORTRAIT_QUERY);
      const onChange = () => relocateHeaderPillsForViewport_();
      if (mobilePortraitMql_.addEventListener) mobilePortraitMql_.addEventListener("change", onChange);
      else if (mobilePortraitMql_.addListener) mobilePortraitMql_.addListener(onChange); // older Safari
    }
  }

  // ---- Mobile-portrait nav drawer ----
  //
  // Replaces the bottom tab bar in mobile portrait (see the same
  // MOBILE_PORTRAIT_QUERY breakpoint above) with a slide-in drawer that
  // reuses the EXACT same #nav-rail element/links every other layout
  // already renders (renderNav above) — just toggled visible via a class
  // on <html> instead of always sitting in the layout, with a translucent
  // backdrop behind it, the same pattern as every other overlay in this
  // file (announcements popover, search overlay, modals).
  const MOBILE_NAV_OPEN_CLASS = "mobile-nav-open";
  // Carries the CSS transition that slides the drawer in/out (see
  // .nav-rail--animatable in css/app.css) — deliberately NOT present by
  // default. Simply shrinking a desktop window across the breakpoint
  // makes .nav-rail's computed transform jump from its desktop value
  // (none) to this breakpoint's closed default (translateX(-100%)) —
  // if that jump were transitioned, the rail would visibly sit on
  // screen, painted in this breakpoint's own (light) background, for
  // the whole transition duration before sliding off — the "flashes
  // white before becoming the hamburger" bug. Added only in response to
  // an actual open/close (see markNavRailAnimatable_ below), so a bare
  // resize/rotation across the breakpoint always renders the closed
  // drawer instantly, with nothing to animate.
  const NAV_RAIL_ANIMATABLE_CLASS = "nav-rail--animatable";
  let mobileNavBackdropEl_ = null;

  function markNavRailAnimatable_() {
    const rail = document.getElementById("nav-rail");
    if (rail) rail.classList.add(NAV_RAIL_ANIMATABLE_CLASS);
  }

  function closeMobileNavDrawer_() {
    markNavRailAnimatable_();
    document.documentElement.classList.remove(MOBILE_NAV_OPEN_CLASS);
    const toggleBtn = document.getElementById("mobile-nav-toggle-btn");
    if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
  }

  function openMobileNavDrawer_() {
    markNavRailAnimatable_();
    document.documentElement.classList.add(MOBILE_NAV_OPEN_CLASS);
    const toggleBtn = document.getElementById("mobile-nav-toggle-btn");
    if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "true");
  }

  function wireMobileNavDrawer_() {
    const toggleBtn = document.getElementById("mobile-nav-toggle-btn");
    if (!toggleBtn) return;

    // The backdrop is a single persistent element (created once, reused
    // across renderHeader calls) rather than rebuilt every time — nothing
    // about it depends on the current page.
    if (!mobileNavBackdropEl_) {
      mobileNavBackdropEl_ = document.createElement("div");
      mobileNavBackdropEl_.className = "mobile-nav-backdrop";
      mobileNavBackdropEl_.addEventListener("click", closeMobileNavDrawer_);
      document.body.appendChild(mobileNavBackdropEl_);
    }

    toggleBtn.addEventListener("click", () => {
      if (document.documentElement.classList.contains(MOBILE_NAV_OPEN_CLASS)) closeMobileNavDrawer_();
      else openMobileNavDrawer_();
    });

    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMobileNavDrawer_(); });

    // Tapping any nav link should close the drawer immediately rather
    // than leaving it open behind the page the link is about to
    // navigate to — a real cross-document navigation makes this mostly
    // moot (the whole page unloads), but a same-page anchor or a link
    // to the page already active wouldn't otherwise close it.
    const rail = document.getElementById("nav-rail");
    if (rail) rail.addEventListener("click", (e) => { if (e.target.closest(".nav-rail__link")) closeMobileNavDrawer_(); });

    // Clears NAV_RAIL_ANIMATABLE_CLASS the moment the device/window
    // leaves this breakpoint, so the NEXT time it's entered (e.g.
    // shrinking the window again later) starts from the same
    // never-animated-yet state that avoids the white-flash bug above —
    // otherwise a class added by an earlier open/close in THIS visit to
    // the breakpoint would still be sitting on the rail, and the
    // desktop-to-breakpoint transform jump would animate (and flash)
    // all over again on the next resize.
    const mql = window.matchMedia(MOBILE_PORTRAIT_QUERY);
    const onBreakpointChange = () => {
      if (!mql.matches && rail) rail.classList.remove(NAV_RAIL_ANIMATABLE_CLASS);
    };
    if (mql.addEventListener) mql.addEventListener("change", onBreakpointChange);
    else if (mql.addListener) mql.addListener(onBreakpointChange);
  }

  // ---- Theme menu (header, between search and the bell) — same
  // static-markup/hidden-toggle pattern as the profile menu above,
  // just with three mutually-exclusive options instead of an action
  // list. ----

  let themeMenuOutsideHandler_ = null;
  let themeMenuKeyHandler_ = null;

  function closeThemeMenu_() {
    const menu = document.getElementById("theme-menu");
    const btn = document.getElementById("theme-menu-btn");
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (themeMenuOutsideHandler_) {
      document.removeEventListener("mousedown", themeMenuOutsideHandler_, true);
      themeMenuOutsideHandler_ = null;
    }
    if (themeMenuKeyHandler_) {
      document.removeEventListener("keydown", themeMenuKeyHandler_);
      themeMenuKeyHandler_ = null;
    }
  }

  function toggleThemeMenu_() {
    const menu = document.getElementById("theme-menu");
    const btn = document.getElementById("theme-menu-btn");
    if (!menu || !btn) return;
    if (!menu.hidden) { closeThemeMenu_(); return; }

    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");

    themeMenuOutsideHandler_ = (e) => {
      if (menu.contains(e.target) || btn.contains(e.target)) return;
      closeThemeMenu_();
    };
    themeMenuKeyHandler_ = (e) => { if (e.key === "Escape") closeThemeMenu_(); };
    setTimeout(() => {
      document.addEventListener("mousedown", themeMenuOutsideHandler_, true);
      document.addEventListener("keydown", themeMenuKeyHandler_);
    }, 0);
  }

  /** Reflects `pref`/`resolved` onto the trigger icon (sun/moon, matching what's actually applied) and the check mark on the active menu item. Safe to call even when the header/menu isn't in the DOM yet. */
  function updateThemeMenuUI_(pref, resolved) {
    const triggerIcon = document.getElementById("theme-menu-icon");
    if (triggerIcon) triggerIcon.innerHTML = resolved === "dark" ? ICONS.moon : ICONS.sun;
    document.querySelectorAll(".theme-menu__item").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.themePref === pref);
    });
  }

  function wireThemeMenu_() {
    const btn = document.getElementById("theme-menu-btn");
    if (btn) btn.addEventListener("click", () => toggleThemeMenu_());
    document.querySelectorAll("#theme-menu [data-theme-pref]").forEach((item) => {
      item.addEventListener("click", () => {
        setThemePreference_(item.dataset.themePref);
        closeThemeMenu_();
      });
    });
  }

  // ---- Sync status indicator (header) ----

  function wireSyncIndicator_() {
    const el = document.getElementById("sync-indicator");
    const label = document.getElementById("sync-indicator__label");
    if (!el || !label) return;

    function render(status, pending) {
      el.classList.remove("sync-indicator--syncing", "sync-indicator--synced", "sync-indicator--error", "sync-indicator--offline");

      // Offline takes priority over whatever syncStatus happens to say —
      // syncStatus only changes in response to an actual write attempt,
      // so with nothing queued yet it can still read "Synced" (green)
      // for a device that's been offline for an hour, which is exactly
      // backwards. navigator.onLine is checked directly here so the pill
      // flips the moment connectivity actually changes, independent of
      // any write ever being attempted.
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      if (offline) {
        el.classList.add("sync-indicator--offline");
        label.textContent = pending > 0 ? (pending > 1 ? `Offline — ${pending} queued` : "Offline — 1 queued") : "Offline";
        return;
      }

      // "idle" (nothing queued/in flight) reads as the resting "Synced"
      // state per the design's always-visible sync pill, rather than
      // being hidden — there's no meaningful difference to the user
      // between "just synced" and "nothing to sync."
      if (status === "idle" || status === "synced") {
        el.classList.add("sync-indicator--synced");
        label.textContent = "Synced";
        return;
      }
      if (status === "syncing") {
        el.classList.add("sync-indicator--syncing");
        label.textContent = pending > 1 ? `Pending (${pending})` : "Pending…";
        return;
      }
      if (status === "error") {
        el.classList.add("sync-indicator--error");
        label.textContent = "Sync failed — tap Refresh";
      }
    }

    Api.onSyncStatusChange(render);

    // The browser's connectivity can change independent of any sync
    // activity at all (WiFi just dropped with nothing queued yet) — listen
    // directly so the pill flips to "Offline" the instant that happens,
    // rather than only the next time a write is attempted and fails.
    const rerenderFromCurrentStatus = () => {
      const s = Api.getSyncStatus();
      render(s.status, s.pending);
    };
    window.addEventListener("online", rerenderFromCurrentStatus);
    window.addEventListener("offline", rerenderFromCurrentStatus);

    // One-time toast right when something ACTUALLY gets queued (not on
    // every subsequent "still syncing" tick) — see Api's outboxListeners.
    Api.onOutboxEnqueue(() => {
      showToast("You're offline — this will be saved and sent automatically once you're back online.", { type: "" });
    });

    // "Data updated: Xm ago" — a hover tooltip on the sync pill itself
    // (see wireTooltips_, which reads data-tooltip live at hover time, so
    // just updating the attribute is enough) rather than a second
    // always-visible header element, keeping the header from getting any
    // more crowded than it already is. This is about READ freshness —
    // how old the sheet data on screen might be — which is a different
    // thing from the pill's own label above (pending WRITES). Refreshed
    // every 30s so a device left open all day shows something honest
    // (e.g. "2h ago") instead of a number frozen at page-load time.
    const updateLastSyncedTooltip = () => {
      const at = Api.getLastSyncedAt ? Api.getLastSyncedAt() : 0;
      el.setAttribute("data-tooltip", `Data updated: ${at ? formatRelativeTime_(at) : "never yet"}`);
    };
    updateLastSyncedTooltip();
    setInterval(updateLastSyncedTooltip, 30000);
  }

  /**
   * The dedicated hard-refresh action requested for the whole app: a
   * single button that clears the read cache and re-runs the CURRENT
   * page's own load()/refresh logic, guaranteeing fresh data rather
   * than whatever's cached. Pages register their own refresh function
   * via Shell.registerRefresh(fn) near the top of their script; if a
   * page hasn't registered one, this falls back to a full reload.
   */
  let pageRefreshFn_ = null;
  function registerRefresh(fn) {
    pageRefreshFn_ = fn;
  }

  /**
   * Standard "load one sheet into a page" helper — the sanctioned entry
   * point for new pages so they don't rehand-roll the stale-while-
   * revalidate + spinner + error + Refresh-wiring dance every time.
   *
   * Behavior (matches what every list page does by hand):
   *   1. Renders instantly from Api's persisted cache if warm.
   *   2. Otherwise shows a spinner in `container`.
   *   3. Revalidates in the background and re-renders when fresher data
   *      lands.
   *   4. On a cold-load failure, shows an error state in `container`;
   *      always surfaces a toast.
   *   5. Registers itself as this page's Refresh action, so the header
   *      Refresh button re-runs it.
   *
   * Usage for a new page:
   *   Shell.mountSheet("Schedule", {
   *     container: document.getElementById("content"),
   *     loadingText: "Loading schedule…",
   *     render: (rows) => renderMyPage(rows)
   *   });
   *
   * `render(rows)` is called with a plain array of row objects every
   * time data is (re)rendered — keep it idempotent and cheap. For pages
   * that need to combine MULTIPLE sheets, keep using Api.getSheetCached
   * directly (see inspections.html / announcements.html).
   */
  function mountSheet(sheetName, { render, container = null, loadingText = "Loading…", extraParams = {} } = {}) {
    function showLoading() {
      if (container) container.innerHTML = `<div class="state-message"><div class="spinner"></div><p>${escapeHtml_(loadingText)}</p></div>`;
    }
    function showError(message) {
      if (container) container.innerHTML = `<div class="state-message"><div class="state-message__icon">⚠️</div><p>${escapeHtml_(message)}</p></div>`;
    }

    // Reuse ONE background-refresh subscriber across every load() (the
    // Refresh button re-invokes load()); dropping the previous one first
    // keeps the header Refresh from stacking up duplicate re-render
    // callbacks over a long session.
    let onFresh = null;
    function load() {
      if (onFresh) Api.unsubscribe(sheetName, onFresh, extraParams);
      onFresh = (fresh) => render(fresh.rows || []);

      const { data: cached, ready } = Api.getSheetCached(sheetName, onFresh, extraParams);

      if (cached) render(cached.rows || []);
      else showLoading();

      return ready.then((data) => {
        if (!cached) render(data.rows || []);
      }).catch((err) => {
        if (!cached) showError(err.message);
        showToast(err.message, { type: "error" });
      });
    }
    registerRefresh(load);
    return load();
  }

  let hardRefreshInFlight_ = false;

  async function hardRefresh() {
    // Guards against a second click re-entering while one is already
    // running (the button is disabled meanwhile, but keyboard Enter /
    // rapid double-click can still fire a second handler call first).
    if (hardRefreshInFlight_) return;
    hardRefreshInFlight_ = true;

    const btn = document.getElementById("hard-refresh-btn");
    const spinner = document.getElementById("hard-refresh-spinner");
    const label = document.getElementById("hard-refresh-label");
    if (btn) { btn.disabled = true; btn.classList.add("is-spinning"); }
    if (spinner) spinner.style.display = "inline-block";
    if (label) label.textContent = "Refreshing…";

    // Guarantee the spinner is visible for at least this long — a
    // refresh that completes from warm cache in well under 100ms used
    // to flash the spinner so briefly it looked like clicking Refresh
    // did nothing at all.
    const minVisible = new Promise((resolve) => setTimeout(resolve, 400));

    try {
      await Api.hardRefresh();
      // Pages' own registered refresh functions already catch and toast
      // their own errors (see roster.html/schedule.html/etc.'s load()),
      // so we deliberately don't layer a generic "Refreshed" toast on
      // top here — it would immediately overwrite a real error toast
      // the page just showed, since showToast() replaces whatever's
      // currently visible.
      const work = pageRefreshFn_ ? pageRefreshFn_() : Promise.resolve(window.location.reload());
      await Promise.all([work, minVisible]);
      loadGlobalAlerts_();
    } catch (err) {
      await minVisible;
      showToast(err && err.message ? err.message : "Refresh failed. Try again.", { type: "error" });
    } finally {
      hardRefreshInFlight_ = false;
      if (btn) { btn.disabled = false; btn.classList.remove("is-spinning"); }
      if (spinner) spinner.style.display = "none";
      if (label) label.textContent = "Refresh";
    }
  }

  // ---- CSV export (of data already on the current page) -----------------
  //
  // A page opts in by calling Shell.registerExport(fn) once its data is
  // loaded. fn() is called at click time and returns
  //   { filename, rows, columns? }
  // — computed live so it always reflects the page's CURRENT, already
  // flight-scoped/visible rows (the same rows on screen), not the raw
  // sheet. If columns is omitted, the union of keys across rows is used.
  // Registering reveals the header Export button; passing null hides it.

  let exportConfig_ = null;

  function registerExport(fn) {
    exportConfig_ = fn;
    const btn = document.getElementById("export-btn");
    if (btn) btn.style.display = fn ? "inline-flex" : "none";
  }

  /** Quote a single CSV field per RFC 4180 (double quotes doubled, wrap when needed). */
  function csvField_(value) {
    if (value === null || value === undefined) return "";
    const str = String(value);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  function buildCsv_(rows, columns) {
    const cols = columns && columns.length
      ? columns
      : Array.from(rows.reduce((set, r) => { Object.keys(r || {}).forEach((k) => set.add(k)); return set; }, new Set()));
    const header = cols.map(csvField_).join(",");
    const body = rows.map((r) => cols.map((c) => csvField_(r ? r[c] : "")).join(",")).join("\r\n");
    return header + "\r\n" + body;
  }

  /**
   * Builds a CSV from rows and triggers a client-side download — no
   * server round-trip, since the data is already in hand. Exposed as
   * Shell.exportCsv for pages that want to export on their own trigger
   * rather than via the header button.
   */
  function exportCsv(filename, rows, columns) {
    const csv = buildCsv_(rows || [], columns);
    // Prepend a UTF-8 BOM so Excel opens accented names / unicode correctly.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "export.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the download has a chance to start first.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function runExport_() {
    if (!exportConfig_) return;
    let result;
    try {
      result = exportConfig_();
    } catch (e) {
      showToast("Couldn't build the export.", { type: "error" });
      return;
    }
    if (!result || !Array.isArray(result.rows) || !result.rows.length) {
      showToast("Nothing to export on this page yet.", { type: "error" });
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = result.filename || `${activePage_ || "export"}-${stamp}.csv`;
    exportCsv(filename, result.rows, result.columns);
    showToast(`Exported ${result.rows.length} row${result.rows.length === 1 ? "" : "s"}.`, { type: "success" });
  }

  // ---- CSV import (bulk row entry) ---------------------------------------
  //
  // The counterpart to exportCsv above — parses a CSV back into row
  // objects so a page (Roster, Schedule) can bulk-write a whole batch
  // instead of adding rows one at a time through its own form. Parsing
  // happens entirely client-side; nothing is sent anywhere until the
  // CALLER decides to Api.writeRow() each parsed row itself, so a bad or
  // accidental file pick costs nothing.

  /**
   * Minimal RFC 4180 CSV parser (quoted fields, doubled-quote escaping,
   * \r\n or \n line endings) — the exact inverse of buildCsv_ above, not
   * a general-purpose CSV library. Returns an array of plain objects
   * keyed by the header row; blank trailing lines are skipped. Throws if
   * the file has no header row or no data rows.
   */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    const pushField = () => { row.push(field); field = ""; };
    const pushRow = () => { pushField(); rows.push(row); row = []; };

    // Strip a leading UTF-8 BOM (exportCsv above writes one) so it
    // doesn't end up glued onto the first header name.
    const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (inQuotes) {
        if (c === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        pushField();
      } else if (c === "\r") {
        // ignore — the following \n (or end of a lone \r-terminated line) handles the row break
      } else if (c === "\n") {
        pushRow();
      } else {
        field += c;
      }
    }
    // Final field/row if the file didn't end with a newline.
    if (field !== "" || row.length) pushRow();

    const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ""));
    if (nonEmpty.length < 1) throw new Error("The file appears to be empty.");
    const headers = nonEmpty[0].map((h) => h.trim());
    if (!headers.length || headers.every((h) => !h)) throw new Error("The file has no header row.");

    return nonEmpty.slice(1).map((r) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = r[i] !== undefined ? r[i] : ""; });
      return obj;
    });
  }

  /**
   * Opens the browser's file picker for a single .csv file and resolves
   * with its parsed rows (see parseCsv above). Resolves with null if the
   * person cancels the picker instead of choosing a file — callers
   * should treat that as a silent no-op, not an error.
   */
  function pickAndParseCsv() {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".csv,text/csv";
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        if (!file) { resolve(null); return; }
        const reader = new FileReader();
        reader.onload = () => {
          try {
            resolve(parseCsv(String(reader.result || "")));
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = () => reject(new Error("Couldn't read that file."));
        reader.readAsText(file);
      }, { once: true });
      input.click();
    });
  }

  // ---- Roster name/role helpers -----------------------------------------
  //
  // The Roster sheet stores a cadet's name as separate FirstName/LastName
  // columns (plus a Role column, populated only for the two flight-staff
  // entries — see isStaffRosterRow_ below). Every page that reads Roster
  // needs the SAME "LastName, FirstName" display string and the SAME
  // flexible name search, so both live here once rather than being
  // reimplemented per page.

  /**
   * "LastName, FirstName" — the one display format used everywhere a
   * cadet's name appears (tables, scorecards, StudentName columns
   * written into other sheets, CSV export, search results). Falls back
   * to whichever of the two parts is present if only one is, and to a
   * legacy combined `Name` field if a row somehow still has one instead
   * of FirstName/LastName (defensive — every current row has been
   * migrated, but this keeps a stray old-shaped row from rendering
   * blank instead of falling back to whatever it actually has).
   */
  function cadetDisplayName_(row) {
    const first = String((row && row.FirstName) || "").trim();
    const last = String((row && row.LastName) || "").trim();
    if (last && first) return `${last}, ${first}`;
    if (last || first) return last || first;
    return String((row && row.Name) || "").trim();
  }

  /** True for a Roster row that's a flight-staff entry (Role populated), not a cadet. */
  function isStaffRosterRow_(row) {
    return !!String((row && row.Role) || "").trim();
  }

  /**
   * Does `row`'s name match a free-typed `query`, accepting "First Last",
   * "Last, First", or a plain partial substring of either name alone?
   * Used by both Roster's own search box (pages/roster.html) and the
   * global search's Roster source below, so both accept the same query
   * shapes. An empty query always matches (the "show everything" case).
   */
  function rosterNameMatches_(row, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return true;
    const first = String((row && row.FirstName) || "").trim().toLowerCase();
    const last = String((row && row.LastName) || "").trim().toLowerCase();
    if (!first && !last) {
      // Legacy fallback row with only a combined Name — plain substring.
      return String((row && row.Name) || "").toLowerCase().includes(q);
    }
    const firstLast = [first, last].filter(Boolean).join(" ");
    const lastCommaFirst = last && first ? `${last}, ${first}` : (last || first);
    return first.includes(q) || last.includes(q) || firstLast.includes(q) || lastCommaFirst.includes(q);
  }

  /**
   * Maps freshly-fetched Roster rows to add a computed `.Name` field
   * ("LastName, FirstName" — see cadetDisplayName_) so every OTHER page
   * that reads Roster (Inspections, Observations, Recommendations, Notes,
   * Overview) can keep displaying/writing `row.Name` exactly as before,
   * unaware the sheet itself now stores FirstName/LastName separately.
   * Call this once, right where each page assigns its local roster rows
   * variable from Api's fetch result.
   */
  function normalizeRosterRows_(rows) {
    return (rows || []).map((r) => ({ ...r, Name: cadetDisplayName_(r) }));
  }

  // ---- Cross-sheet search (client-side, over already-cached sheets) -----
  //
  // Searches only sheets whose corresponding PAGE this position is
  // allowed to see (so search never surfaces data from a page the
  // position can't open), and applies the same per-Flight scoping the
  // pages themselves use for Roster/Inspections/Notes. All data comes
  // from Api's persisted cache — the same rows already warmed on every
  // page load — so this makes no extra network calls of its own beyond
  // the background revalidation getSheetCached always does.

  const SEARCH_SOURCES = [
    {
      sheet: "Roster", page: "roster", label: "Roster", href: "pages/roster.html",
      flightField: "Flight",
      fields: ["CapId", "Rank", "Flight"],
      // Name matching goes through rosterNameMatches_ (see `matches`
      // below) instead of a plain substring over a `Name` field — the
      // raw cached row only has FirstName/LastName, and this accepts
      // "First Last" / "Last, First" / a partial of either.
      matches: (r, q) => rosterNameMatches_(r, q) || ["CapId", "Rank", "Flight"].some((f) => String(r[f] || "").toLowerCase().includes(q)),
      title: (r) => cadetDisplayName_(r) || r.CapId || "—",
      meta: (r) => [r.Rank, r.CapId, r.Flight].filter(Boolean).join(" · ")
    },
    {
      sheet: "UniformInspections", page: "inspections", label: "Uniform inspection", href: "pages/inspections.html",
      flightField: "Flight",
      fields: ["StudentName", "StudentCapId", "InspectingPosition"],
      title: (r) => r.StudentName || r.StudentCapId || "—",
      meta: (r) => [r.Date, r.Flight, (r.TotalPoints != null ? `${r.TotalPoints} pts` : "")].filter(Boolean).join(" · ")
    },
    {
      sheet: "RoomInspections", page: "inspections", label: "Room inspection", href: "pages/inspections.html",
      flightField: "Flight",
      fields: ["StudentName", "StudentCapId", "InspectingPosition"],
      title: (r) => r.StudentName || r.StudentCapId || "—",
      meta: (r) => [r.Date, r.Flight, (r.TotalPoints != null ? `${r.TotalPoints} pts` : "")].filter(Boolean).join(" · ")
    },
    {
      sheet: "Observations", page: "observations", label: "Observation", href: "pages/observations.html",
      flightField: "Flight",
      fields: ["StudentName", "StudentCapId", "Tag", "Note", "LoggerPosition"],
      title: (r) => r.StudentName || r.StudentCapId || "—",
      meta: (r) => [r.Category, r.Sentiment, r.Timestamp ? formatDateTime_(r.Timestamp) : ""].filter(Boolean).join(" · "),
      snippet: (r) => r.Note
    },
    {
      sheet: "Notes", page: "notes", label: "Note", href: "pages/notes.html",
      flightField: "Flight", flightBlankVisible: true,
      fields: ["Subject", "AuthorPosition", "__bodyText"],
      title: (r) => r.Subject || "(no subject)",
      meta: (r) => [r.AuthorPosition, r.Flight].filter(Boolean).join(" · "),
      snippet: (r) => r.__bodyText
    },
    {
      sheet: "Announcements", page: "announcements", label: "Announcement", href: "pages/announcements.html",
      fields: ["Position", "__bodyText"],
      title: (r) => r.Position || "Announcement",
      meta: (r) => r.Timestamp ? formatDateTime_(r.Timestamp) : "",
      snippet: (r) => r.__bodyText
    },
    {
      sheet: "Schedule", page: "schedule", label: "Schedule", href: "pages/schedule.html",
      // No explicit fields — search every value in the row.
      title: (r) => r.Activity || r.Event || r.Title || Object.values(r).find(Boolean) || "—",
      meta: (r) => [r.Day, r.Date, r.Time, r.Location].filter(Boolean).join(" · ")
    }
  ];

  function sessionFlights_() {
    const s = Auth.getSession();
    return (s && Array.isArray(s.Flights)) ? s.Flights : [];
  }

  /**
   * Does `viewerFlights` (a session's Flights list — the individual
   * flight(s), e.g. ["Alpha"], a position is scoped to) have visibility
   * into a row/event whose own Flight/audience value is `targetFlight`
   * (e.g. "Alpha", "Squadron 1", or blank/"All")?
   *
   * Squadrons have no cadets of their own — they're a grouping of
   * flights (see APP_CONFIG.SQUADRON_FLIGHTS) — so an exact string
   * match alone means a schedule item audienced to "Squadron 1" was
   * only ever visible to whoever's OWN Flights literally equals the
   * string "Squadron 1", never to "Alpha" or "Bravo" even though
   * they're that squadron's actual members. This also checks whether
   * targetFlight is a known squadron and, if so, whether the viewer
   * belongs to any flight under it.
   */
  function flightMatchesAudience_(viewerFlights, targetFlight) {
    const flights = Array.isArray(viewerFlights) ? viewerFlights : [];
    if (!flights.length) return true;
    if (flights.some((f) => String(f).toLowerCase() === "all")) return true;
    if (!targetFlight) return true;
    const target = String(targetFlight).toLowerCase();
    if (flights.some((f) => String(f).toLowerCase() === target)) return true;

    const squadronFlights = (window.APP_CONFIG && window.APP_CONFIG.SQUADRON_FLIGHTS) || {};
    const members = squadronFlights[target];
    if (members && members.some((m) => flights.some((f) => String(f).toLowerCase() === String(m).toLowerCase()))) {
      return true;
    }
    return false;
  }

  function isFlightAllowed_(flight) {
    return flightMatchesAudience_(sessionFlights_(), flight);
  }

  // ---- Flight color (see Api.getFlightColors / APP_CONFIG.FLIGHT_COLORS) -
  //
  // Three layers, checked in order:
  //   1. SYNCED colors — the ACTUAL cell background colors read off
  //      Roster's Flight column in the Google Sheet (see
  //      worker/src/sheets.js's getColumnBackgroundColorsByValue), synced
  //      by an admin (Api.adminSyncFlightColors) and fetched once per
  //      browser session by every signed-in device (see
  //      initFlightColorSync_ below, wired into Shell.init). This is the
  //      one that actually matches the Sheet.
  //   2. APP_CONFIG.FLIGHT_COLORS (js/config.js) — a hand-typed fallback,
  //      only relevant before any admin has ever run the sync (or if the
  //      fetch fails/hasn't landed yet on this page load).
  //   3. A deterministic (stable per name, not independently tunable) hue
  //      hashed from the flight name itself, so an unrecognized name —
  //      a squadron, or a flight neither layer above has heard of — still
  //      gets SOME distinct color instead of looking identical to every
  //      other unlisted one.
  // Blank/missing flight names fall back to a neutral gray — "no flight"
  // isn't an identity to color.

  let syncedFlightColors_ = null; // null until the fetch below resolves (or fails)

  function hexToRgb_(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || ""));
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
  }

  function flightColor_(flight) {
    const key = String(flight || "").trim().toLowerCase();
    if (!key) return "#94a3b8";
    if (syncedFlightColors_ && syncedFlightColors_[key]) return syncedFlightColors_[key];
    const configured = (window.APP_CONFIG && window.APP_CONFIG.FLIGHT_COLORS) || {};
    if (configured[key]) return configured[key];
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    return `hsl(${hash % 360}, 55%, 45%)`;
  }

  // Persisted so the NEXT page load has last-known synced colors
  // available synchronously, before the network fetch below even
  // resolves — same "instant render from a local snapshot, refresh in
  // the background" pattern Api's own sheet cache already uses. Without
  // this, every single page navigation would render its FIRST paint
  // with the fallback (layer 2/3) colors and only pick up the real ones
  // on some later re-render that may never actually happen, since flight
  // color isn't wired into any page's own onFresh/re-render machinery.
  const FLIGHT_COLORS_STORAGE_KEY = "njwg_flight_colors_v1";

  /**
   * Hydrates syncedFlightColors_ synchronously from the last page's
   * snapshot, then fetches the current map in the background (via Api's
   * own request path, so it's still subject to normal device/session
   * token handling) and re-persists it for next time. Best-effort: a
   * failure just leaves whatever's already in effect (the snapshot, or
   * layer 2/3) alone.
   */
  function initFlightColorSync_() {
    try {
      const raw = localStorage.getItem(FLIGHT_COLORS_STORAGE_KEY);
      if (raw) syncedFlightColors_ = JSON.parse(raw);
    } catch (e) { /* corrupt/unavailable — falls through to the network fetch */ }

    if (typeof Api === "undefined" || !Api.getFlightColors) return;
    Api.getFlightColors().then((data) => {
      syncedFlightColors_ = (data && data.colors) || {};
      try { localStorage.setItem(FLIGHT_COLORS_STORAGE_KEY, JSON.stringify(syncedFlightColors_)); } catch (e) { /* ignore */ }
    }).catch(() => { /* whatever was hydrated above (or layer 2/3) still applies */ });
  }

  /**
   * Re-fetches the flight color map right now instead of waiting for the
   * next page load — exposed as Shell.refreshFlightColors so the "Sync
   * from Roster" button on Admin's Worker Settings tab can make its OWN
   * device reflect the change it just made immediately, rather than the
   * admin wondering why nothing looks different until they reload.
   * Returns the promise so a caller can await it before re-rendering.
   */
  function refreshFlightColors_() {
    if (typeof Api === "undefined" || !Api.getFlightColors) return Promise.resolve();
    return Api.getFlightColors().then((data) => {
      syncedFlightColors_ = (data && data.colors) || {};
      try { localStorage.setItem(FLIGHT_COLORS_STORAGE_KEY, JSON.stringify(syncedFlightColors_)); } catch (e) { /* ignore */ }
    });
  }

  // ---- "Advanced Training School" flights ------------------------------
  //
  // A fixed, hardcoded set of flight names (not an admin-configurable
  // toggle) — India and Juliet are ATS flights, full stop. They're
  // excluded from Overview's Flight Standings and Awards' Weekly
  // Standings for every viewer (see computeFlightStandings/
  // cadetRawMetrics), and from the general/blank-audience "traditional"
  // schedule (see scheduleAudienceMatches_ below) — everything else
  // about them (Roster, Inspections, logins) works exactly like any
  // other flight. Managing them day-to-day is just an ordinary
  // StaffAccess position (e.g. one named "Advanced Training School"
  // scoped to Flights: ["India", "Juliet"]) — nothing about THAT is
  // special-cased in code.
  const ATS_FLIGHT_NAMES = new Set(["india", "juliet"]);

  /** Whether `flight` is one of the fixed ATS flights above — case/whitespace-insensitive, same convention as flightColor_. */
  function isAtsFlight_(flight) {
    return ATS_FLIGHT_NAMES.has(String(flight || "").trim().toLowerCase());
  }

  /** The same flight color as flightColor_, at low opacity — for a tinted background behind that color's own text/border, matching the app's existing tint-pair convention (--gold-500/--gold-100, etc.). */
  function flightColorTint_(flight) {
    const color = flightColor_(flight);
    const rgb = hexToRgb_(color);
    if (rgb) return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`;
    // hsl(...) fallback from the hash-derived case above.
    return color.replace("hsl(", "hsla(").replace(/\)$/, ", 0.15)");
  }

  /** Flattens a rich-text/HTML value to plain searchable text. */
  function htmlToText_(html) {
    if (!html) return "";
    const t = document.createElement("template");
    t.innerHTML = String(html);
    return (t.content.textContent || "").replace(/\s+/g, " ").trim();
  }

  let searchOverlayEl_ = null;
  let searchKeyHandler_ = null;

  function closeSearch_() {
    if (searchOverlayEl_) { searchOverlayEl_.remove(); searchOverlayEl_ = null; }
    if (searchKeyHandler_) { document.removeEventListener("keydown", searchKeyHandler_); searchKeyHandler_ = null; }
  }

  function allowedSearchSources_() {
    const allowed = getAllowedPageIds();
    return SEARCH_SOURCES.filter((src) => allowed.has(src.page));
  }

  function runSearch_(query, resultsEl) {
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      resultsEl.innerHTML = `<div class="search-overlay__hint">Type at least 2 characters…</div>`;
      return;
    }

    const groups = [];
    allowedSearchSources_().forEach((src) => {
      const handle = Api.getSheetCached(src.sheet);
      const rows = (handle.data && handle.data.rows) || [];
      const matches = [];
      for (const raw of rows) {
        // Notes/Announcements bodies are HTML — expose a plain-text field.
        const row = ("Body" in raw || "Message" in raw)
          ? { ...raw, __bodyText: htmlToText_(raw.Body || raw.Message || "") }
          : raw;

        // Flight scoping: skip rows this position isn't allowed to see.
        if (src.flightField) {
          const flight = row[src.flightField];
          const blankOk = src.flightBlankVisible && !flight;
          if (!blankOk && !isFlightAllowed_(flight)) continue;
        }

        // A source can supply its own `matches(row, q)` predicate (Roster
        // does, for name-shape-flexible matching — see rosterNameMatches_)
        // instead of the default plain substring-over-fields check.
        const isMatch = src.matches
          ? src.matches(row, q)
          : String(src.fields ? src.fields.map((f) => row[f]).join(" ") : Object.values(row).join(" ")).toLowerCase().includes(q);
        if (isMatch) {
          matches.push(row);
          if (matches.length >= 8) break; // cap per source
        }
      }
      if (matches.length) groups.push({ src, matches });
    });

    if (!groups.length) {
      resultsEl.innerHTML = `<div class="search-overlay__hint">No matches for “${escapeHtml_(query)}”.</div>`;
      return;
    }

    resultsEl.innerHTML = groups.map((g) => `
      <div class="search-overlay__group">
        <div class="search-overlay__group-label">${escapeHtml_(g.src.label)}</div>
        ${g.matches.map((r) => {
          const snippet = g.src.snippet ? g.src.snippet(r) : "";
          const meta = g.src.meta ? g.src.meta(r) : "";
          return `
            <a class="search-overlay__result" href="${window.APP_BASE_PATH}${g.src.href}">
              <div class="search-overlay__result-title">${escapeHtml_(g.src.title(r))}</div>
              ${meta ? `<div class="search-overlay__result-meta">${escapeHtml_(meta)}</div>` : ""}
              ${snippet ? `<div class="search-overlay__result-snippet">${escapeHtml_(snippet.slice(0, 140))}</div>` : ""}
            </a>`;
        }).join("")}
      </div>
    `).join("");
  }

  /**
   * Opens the global search overlay. Debounces input, searches the
   * allowed cached sheets, and lets the person click through to the
   * relevant page. Closes on Escape, an outside click, or the × button.
   */
  function openSearch_() {
    if (searchOverlayEl_) { closeSearch_(); return; }

    const overlay = document.createElement("div");
    overlay.className = "search-overlay";
    overlay.innerHTML = `
      <div class="search-overlay__panel" role="dialog" aria-modal="true" aria-label="Search">
        <div class="search-overlay__bar">
          <span class="search-overlay__icon">${ICONS.search}</span>
          <input type="text" id="search-overlay-input" class="search-overlay__input" aria-label="Search cadets, inspections, notes, and announcements" placeholder="Search cadets, inspections, notes, announcements…" autocomplete="off" spellcheck="false">
          <button type="button" class="search-overlay__close" aria-label="Close">&times;</button>
        </div>
        <div class="search-overlay__results" id="search-overlay-results">
          <div class="search-overlay__hint">Type at least 2 characters…</div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    searchOverlayEl_ = overlay;

    const input = overlay.querySelector("#search-overlay-input");
    const results = overlay.querySelector("#search-overlay-results");

    // Warm the searchable sheets so a cold cache fills in and re-search
    // once data lands (getSheetCached kicks off the background fetch).
    allowedSearchSources_().forEach((src) => {
      Api.getSheetCached(src.sheet, () => {
        if (searchOverlayEl_ === overlay && input.value.trim().length >= 2) runSearch_(input.value, results);
      });
    });

    let debounce = null;
    input.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => runSearch_(input.value, results), 150);
    });

    overlay.querySelector(".search-overlay__close").addEventListener("click", closeSearch_);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeSearch_(); });
    searchKeyHandler_ = (e) => { if (e.key === "Escape") closeSearch_(); };
    document.addEventListener("keydown", searchKeyHandler_);

    input.focus();
  }

  // ---- Web Push (opt-in per device) -------------------------------------
  //
  // Real Web Push so a staff device gets a New Announcement alert even
  // when the app is closed or backgrounded (the in-app alert modal only
  // fires while a page is open). Entirely optional and gracefully
  // absent when the backend has no VAPID keys configured — pushConfig
  // reports enabled:false and the enable button stays hidden.
  //
  // The Worker (worker/src/index.js's maybeDispatchPush) can still fan
  // out a Black Flag push too — that side is untouched — it's just that
  // nothing in the frontend triggers a BlackFlagStatus write anymore
  // pending a future pass (see the comment on the Announcements-bell
  // section above).

  function urlBase64ToUint8Array_(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // initPush_ runs on EVERY page load (see Shell.init below) — this app is
  // a full multi-page site, not an SPA, so a staffer clicking through a
  // handful of pages used to re-PUT the exact same, unchanged subscription
  // to KV that many times in a row. The subscription itself doesn't change
  // page to page, and its 90-day server-side TTL (PUSH_SUB_TTL_SECONDS in
  // worker/src/index.js) doesn't need touching anywhere near that often —
  // this localStorage timestamp throttles the "already subscribed, just
  // keep the backend record fresh" re-save to once a day per device,
  // cutting what was easily the single largest source of KV writes in the
  // app down to a small, bounded fraction of it. A genuinely NEW
  // subscription (first opt-in, or the browser silently rotating the
  // endpoint) always saves immediately regardless of this timer — only a
  // confirmed-unchanged endpoint gets throttled.
  const PUSH_RESAVE_KEY = "njwg_push_last_saved";
  const PUSH_RESAVE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

  function shouldResavePushSubscription_(endpoint) {
    try {
      const raw = localStorage.getItem(PUSH_RESAVE_KEY);
      if (!raw) return true;
      const saved = JSON.parse(raw);
      if (saved.endpoint !== endpoint) return true; // rotated/first-seen endpoint — always resave
      return (Date.now() - saved.at) >= PUSH_RESAVE_INTERVAL_MS;
    } catch (e) {
      return true; // corrupt/unreadable — err toward saving rather than silently skipping forever
    }
  }

  function markPushSubscriptionSaved_(endpoint) {
    try { localStorage.setItem(PUSH_RESAVE_KEY, JSON.stringify({ endpoint, at: Date.now() })); } catch (e) { /* storage full/blocked */ }
  }

  async function initPush_() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
    let config;
    try {
      config = await Api.getPushConfig();
    } catch (e) {
      return; // backend unreachable or push not wired — stay silent
    }
    if (!config || !config.enabled || !config.vapidPublicKey) return;
    pushVapidKey_ = config.vapidPublicKey;

    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        // Already subscribed on this device — make sure the backend still
        // has it, but only actually re-save when it's been a while (or
        // this is a different endpoint than what was last confirmed
        // saved) — see the throttling comment above. Either way, keep the
        // button hidden; there's nothing for this device to opt into.
        if (shouldResavePushSubscription_(existing.endpoint)) {
          Api.savePushSubscription(existing.toJSON())
            .then(() => markPushSubscriptionSaved_(existing.endpoint))
            .catch(() => {});
        }
        return;
      }
    } catch (e) { /* fall through to showing the button */ }

    if (Notification.permission === "denied") return; // can't prompt again
    const btn = document.getElementById("push-enable-btn");
    if (btn) btn.style.display = "inline-flex";
  }

  let pushVapidKey_ = null;

  async function enablePush_() {
    const btn = document.getElementById("push-enable-btn");
    if (!pushVapidKey_) { showToast("Alerts aren't available right now.", { type: "error" }); return; }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        showToast("Alerts need notification permission to work.", { type: "error" });
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array_(pushVapidKey_)
      });
      await Api.savePushSubscription(sub.toJSON());
      markPushSubscriptionSaved_(sub.endpoint);
      if (btn) btn.style.display = "none";
      showToast("Alerts enabled on this device.", { type: "success" });
    } catch (e) {
      showToast("Couldn't enable alerts. Try again.", { type: "error" });
    }
  }

  // ---- Install prompt (Add to Home Screen) -------------------------------
  //
  // Staff mostly use this on tablets, so getting it onto the home screen
  // (full-screen standalone launch, no browser chrome, works offline) is a
  // real usability win, not just a checkbox. Two entirely different paths:
  //   - Chrome/Edge/Android: the browser fires `beforeinstallprompt`, which
  //     we capture and replay later from our own themed button — the native
  //     event only offers a generic browser-styled mini-infobar otherwise.
  //   - iOS/iPadOS Safari (and any iOS browser, since all iOS browsers are
  //     WebKit under Apple's rules): there is NO programmatic install API at
  //     all — `beforeinstallprompt` never fires. The only way to install is
  //     the person manually using Share -> Add to Home Screen, so the best
  //     we can do is surface clear on-screen instructions for that.
  // Either way, the button hides itself once the app is already running
  // standalone (installed) — no point offering to install what's already
  // installed and currently open.

  function isStandalone_() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true; // iOS Safari's own (non-standard) flag
  }

  function isIos_() {
    // No feature-detectable API for "is this iOS" — UA sniffing is the only
    // option here, same as every other PWA install-prompt implementation.
    // navigator.standalone existing at all (regardless of its value) is
    // itself an iOS-Safari-only signal, used as a secondary check on iPadOS
    // 13+, which changed iPad's UA string to claim "Macintosh".
    return /iphone|ipad|ipod/i.test(navigator.userAgent || "") ||
      (typeof navigator.standalone !== "undefined");
  }

  let deferredInstallPrompt_ = null;

  /** Whether the install button should be showing right now, independent of whether renderHeader() has run yet. */
  function canOfferInstall_() {
    if (isStandalone_()) return false;
    return !!deferredInstallPrompt_ || isIos_();
  }

  function initInstallPrompt_() {
    if (isStandalone_()) return; // already installed and running as the app — nothing to offer

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault(); // suppress the browser's own generic mini-infobar
      deferredInstallPrompt_ = e;
      const btn = document.getElementById("pwa-install-btn");
      if (btn) btn.style.display = "inline-flex";
    });

    window.addEventListener("appinstalled", () => {
      // Covers installing via the browser's OWN native UI too (e.g. the
      // address-bar icon), not just our button — either way, stop offering.
      deferredInstallPrompt_ = null;
      const btn = document.getElementById("pwa-install-btn");
      if (btn) btn.style.display = "none";
      showToast("App installed.", { type: "success" });
    });

    // iOS never fires beforeinstallprompt, so show the button immediately
    // (this runs before renderHeader() below in init(), and renderHeader's
    // own installBtn wiring already re-checks canOfferInstall_() for the
    // case where the header was rendered first).
    if (isIos_()) {
      const btn = document.getElementById("pwa-install-btn");
      if (btn) btn.style.display = "inline-flex";
    }
  }

  async function promptInstall_() {
    if (isIos_() && !deferredInstallPrompt_) {
      showIosInstallInstructions_();
      return;
    }
    if (!deferredInstallPrompt_) {
      showToast("Installing isn't available on this browser right now.", { type: "error" });
      return;
    }
    // A captured beforeinstallprompt event can only be prompted ONCE —
    // consume it regardless of outcome so a second click doesn't silently
    // no-op; if the browser offers another one later, the listener above
    // replaces deferredInstallPrompt_ and re-shows the button.
    const event = deferredInstallPrompt_;
    deferredInstallPrompt_ = null;
    event.prompt();
    const { outcome } = await event.userChoice;
    const btn = document.getElementById("pwa-install-btn");
    if (outcome === "accepted") {
      if (btn) btn.style.display = "none";
      // appinstalled also fires and shows its own toast; no need to duplicate here.
    } else if (btn) {
      // Declined — offering again immediately would be pushy. It reappears
      // if the browser fires a fresh beforeinstallprompt in a later session.
      btn.style.display = "none";
    }
  }

  function showIosInstallInstructions_() {
    showInfoModal_({
      title: "Install on this device",
      // The exact icon/wording differs slightly between actual Safari
      // (Share sheet) and Chrome-for-iOS (its own "..." menu), but both
      // paths land on an "Add to Home Screen" action — this covers the
      // common (Safari) case, which is what most staff will be using.
      bodyHtml: `
        <ol style="margin:0; padding-left: 1.25em; text-align:left; display:flex; flex-direction:column; gap: var(--space-2);">
          <li>Tap the <strong>Share</strong> button (the square with an arrow, in Safari's toolbar).</li>
          <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
          <li>Tap <strong>Add</strong> — the app icon appears on your home screen, opening full-screen with no browser bar.</li>
        </ol>
      `
    });
  }

  // ---- Service worker update: applied silently in the background ---------
  //
  // service-worker.js calls self.skipWaiting() on install and clients.claim()
  // on activate, so a new deploy takes over almost immediately rather than
  // waiting for every tab to fully close first — but that means the CURRENT
  // page's already-loaded JS/CSS can end up mismatched with whatever the now-
  // active worker would serve on the next request. `controllerchange` fires
  // the moment a new worker takes control; this reloads right away, with no
  // confirmation prompt — writes are saved as they're made (see every page's
  // own save-on-change handlers), so there's nothing an unannounced refresh
  // could actually lose, and this only fires for a REAL update — the
  // first-ever install of the service worker also fires this same event,
  // which must NOT reload (there's nothing to "update" yet, and every page
  // would loop-reload on its very first load otherwise). A brief toast after
  // the reload (see the sessionStorage flag below and its read in init())
  // is the only sign this happened — not a permission prompt, just a
  // heads-up once the new version is already showing.
  function initUpdatePrompt_() {
    if (!("serviceWorker" in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading || !hadController) return;
      reloading = true;
      try { sessionStorage.setItem("njwg_just_auto_updated", "1"); } catch (e) { /* ignore */ }
      window.location.reload();
    });

    // controllerchange only fires once a NEW worker actually takes
    // over — but the browser only checks service-worker.js for changes
    // on its own schedule, at most once every ~24h, and only alongside
    // a navigation. This app is used almost entirely as a home-screen
    // PWA that staff open once and leave running (that's the whole
    // point of an encampment-week app), so a session can go the entire
    // week without a single qualifying navigation, meaning that
    // built-in check never fires at all — which is exactly why a
    // deploy previously required deleting and reinstalling the app to
    // pick up. Force an explicit check ourselves: once right away,
    // again whenever the app is foregrounded after being backgrounded
    // (the common way someone actually returns to a home-screen PWA),
    // and on a periodic timer as a safety net for a session that's
    // simply never backgrounded. registration.update() is a cheap,
    // idempotent fetch — safe to call redundantly from more than one
    // of these triggers.
    navigator.serviceWorker.ready.then((registration) => {
      const checkForUpdate = () => registration.update().catch(() => {});
      checkForUpdate();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") checkForUpdate();
      });
      window.addEventListener("focus", checkForUpdate);
      window.addEventListener("pageshow", checkForUpdate);
      setInterval(checkForUpdate, 30 * 60 * 1000);
    });
  }

  function encampmentDayInfo() {
    const start = new Date(window.APP_CONFIG.ENCAMPMENT_START_DATE + "T00:00:00");
    const end = new Date(window.APP_CONFIG.ENCAMPMENT_END_DATE + "T00:00:00");
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const totalDays = Math.round((end - start) / 86400000) + 1;
    const dayNumber = Math.round((today - start) / 86400000) + 1;

    if (dayNumber < 1) return { label: "ENCAMPMENT NOT STARTED", isActive: false };
    if (dayNumber > totalDays) return { label: "ENCAMPMENT COMPLETE", isActive: false };
    return { label: `DAY ${dayNumber} OF ${totalDays}`, isActive: true, dayNumber };
  }

  // ---- "Current"/"next" schedule item (Overview card + Schedule row highlight) ----
  //
  // A Schedule row has no real datetime, just a free-text Day label
  // (e.g. "Monday", "Day 3") and a free-text Time (e.g. "0600"). These
  // helpers turn that into "what's happening right now" without
  // requiring the sheet to be restructured.

  const WEEKDAY_NAMES_ = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  /** Parses a Time value like "0600", "6:00", or "0600-0700" into minutes-since-midnight, or null if unparseable. */
  function parseScheduleTime_(timeStr) {
    if (!timeStr) return null;
    const m = String(timeStr).match(/(\d{1,2}):?(\d{2})/);
    if (!m) return null;
    const hours = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    if (isNaN(hours) || isNaN(minutes) || hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  function pad2_(n) { return String(n).padStart(2, "0"); }

  /** Today's date as YYYY-MM-DD, in the device's local timezone. */
  function todayIso_() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2_(d.getMonth() + 1)}-${pad2_(d.getDate())}`;
  }

  /**
   * Loosely matches a Schedule row's Day value against "today" — every
   * encampment seems to label days differently, so this tries the
   * current weekday's full/short name ("Monday"/"Mon") and the current
   * encampment day number ("Day 3" or bare "3") from encampmentDayInfo().
   */
  function isScheduleDayToday_(dayValue) {
    const value = String(dayValue || "").trim().toLowerCase();
    if (!value) return false;
    const weekday = WEEKDAY_NAMES_[new Date().getDay()];
    if (value === weekday.toLowerCase() || value === weekday.slice(0, 3).toLowerCase()) return true;
    const info = encampmentDayInfo();
    if (info.dayNumber) {
      if (value === `day ${info.dayNumber}` || value === String(info.dayNumber)) return true;
    }
    return false;
  }

  /**
   * Whether a Schedule row belongs to "today". Prefers an exact match
   * against the row's Date (YYYY-MM-DD, picked from a date input) when
   * present — the precise, unambiguous signal — and falls back to the
   * looser Day-text heuristic above for older rows saved before Date
   * existed.
   */
  function isScheduleRowToday_(row) {
    if (row && row.Date) return row.Date === todayIso_();
    return isScheduleDayToday_(row && row.Day);
  }

  /**
   * Returns { current, next } — the Schedule row (by reference, from
   * `rows`) currently in progress and the one coming up next, scoped to
   * `flights` (same blank-Flight/"All"-means-everyone convention as
   * Roster/Notes/Inspections) and to rows whose Day/Date matches today.
   * Both null if nothing today has a parseable Time.
   */
  /**
   * Same as flightMatchesAudience, but "Advanced Training School"-aware
   * — only used for Schedule's own audience matching (the Overview Now/
   * Next banner; see currentAndNextScheduleItems below), not the generic
   * helper every other page's visibility check shares, since only
   * Schedule has an "ATS"-audienced item concept.
   *
   * An unscoped viewer (CCT/Administrator — blank/"all" Flights) still
   * sees every schedule item, same as always. Otherwise: a viewer whose
   * OWN flight(s) are ALL ATS-flagged doesn't match the general/blank
   * "All" audience (the traditional encampment schedule isn't meant for
   * them) — only an "ATS"-audienced item, or one addressed to their own
   * flight/squadron by name same as anyone else. A viewer who ISN'T
   * ATS-only never matches an "ATS"-audienced item, the same "not their
   * audience" treatment a squadron they don't belong to already gets.
   */
  function scheduleAudienceMatches_(viewerFlights, targetFlight) {
    const flights = Array.isArray(viewerFlights) ? viewerFlights : [];
    const unscoped = !flights.length || flights.some((f) => String(f).toLowerCase() === "all");
    if (unscoped) return true;

    const target = String(targetFlight || "").trim();
    const isAtsTarget = target.toLowerCase() === "ats";
    const viewerIsAtsOnly = flights.every((f) => isAtsFlight_(f));

    if (viewerIsAtsOnly) {
      if (isAtsTarget) return true;
      if (!target) return false;
      return flightMatchesAudience_(flights, target);
    }
    if (isAtsTarget) return false;
    return flightMatchesAudience_(flights, target);
  }

  function currentAndNextScheduleItems(rows, flights) {
    const flightList = Array.isArray(flights) ? flights : [];
    const isAllowed = (row) => scheduleAudienceMatches_(flightList, row.Flight);

    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const todays = (rows || [])
      .filter((r) => isScheduleRowToday_(r) && isAllowed(r))
      .map((r) => ({ row: r, minutes: parseScheduleTime_(r.Time) }))
      .filter((x) => x.minutes !== null)
      .sort((a, b) => a.minutes - b.minutes);

    let current = null, next = null;
    for (const item of todays) {
      if (item.minutes <= nowMinutes) current = item.row;
      else { next = item.row; break; }
    }
    return { current, next };
  }

  // ---- Announcements bell (global, every page) ----
  //
  // Black Flag used to have both a compact header pill (rendered here)
  // and its own Overview weather-card banner — both removed from the
  // frontend pending a future pass (see the comment on
  // OBSERVATION_CATEGORIES in pages/observations.html for the sibling
  // removal this shipped alongside). The BlackFlagStatus sheet and the
  // Worker's read/write/push support for it (worker/src/index.js,
  // worker/src/auth.js) are untouched.

  function getAnnouncementsLastSeen_() {
    return Number(localStorage.getItem(positionScopedKey_(ANNOUNCEMENTS_SEEN_KEY_PREFIX)) || 0);
  }

  function markAnnouncementsSeen_() {
    localStorage.setItem(positionScopedKey_(ANNOUNCEMENTS_SEEN_KEY_PREFIX), String(Date.now()));
    const badge = document.getElementById("announcements-badge");
    if (badge) badge.style.display = "none";
  }

  // ---- Notifications feed (bell popover) ----
  //
  // Merges two otherwise-separate sources — Announcements and Notes
  // addressed to me — into one reverse-chronological feed and one
  // unseen-count badge, so "check what's new" is one place instead of
  // two. Kept up to date by loadGlobalAlerts_'s subscriptions below; the
  // popover (see toggleAnnouncementsPopover_) reads from these same
  // cached arrays instead of re-fetching.
  //
  // Black Flag used to be a third source here (a single-row "current
  // status" entry, since BlackFlagStatus has no history of past toggles
  // to feed a real log the way Announcements/Notes do) — removed from
  // the frontend pending a future pass; see the comment on
  // getAnnouncementsLastSeen_'s section above.

  let lastAnnouncementRows_ = [];
  let lastNotesToMeRows_ = [];

  function notesToMe_(notes) {
    const session = Auth.getSession();
    const myPosition = session && session.Position ? String(session.Position).trim().toLowerCase() : "";
    if (!myPosition) return [];
    return notes.filter(n => String(n.ToPosition || "").trim().toLowerCase() === myPosition);
  }

  /** Unified feed entries, newest first — the single source both the popover list and the badge count read from. */
  function mergedNotificationEntries_() {
    const entries = [];
    lastAnnouncementRows_.forEach(a => entries.push({
      type: "announcement", icon: "📣", timestamp: a.Timestamp,
      title: a.Position || "Announcement",
      body: messagePreviewText_(a.Message || "")
    }));
    lastNotesToMeRows_.forEach(n => entries.push({
      type: "note", icon: "📝", timestamp: n.Timestamp,
      title: `Note from ${n.AuthorPosition || "Staff"}`,
      body: n.Subject || messagePreviewText_(n.Body || "")
    }));
    return entries
      .filter(e => e.timestamp && !isNaN(new Date(e.timestamp).getTime()))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  function updateAnnouncementsBadge_() {
    const badge = document.getElementById("announcements-badge");
    if (!badge) return;
    const lastSeen = getAnnouncementsLastSeen_();
    const unseenCount = mergedNotificationEntries_().filter(e => new Date(e.timestamp).getTime() > lastSeen).length;

    if (unseenCount > 0) {
      badge.textContent = unseenCount > 9 ? "9+" : String(unseenCount);
      badge.style.display = "inline-block";
    } else {
      badge.style.display = "none";
    }
  }

  // ---- Notes-sent-to-me badge (nav-rail Notes link) ----
  //
  // Keyed per-POSITION (not just per-device) since a shared tablet can
  // sign in as different positions over its lifetime — a note sent to
  // "Bravo Flight" shouldn't still show as unseen once the device signs
  // in as "Alpha Flight" and back.

  function notesSeenKey_() {
    const session = Auth.getSession();
    const position = session && session.Position ? String(session.Position).trim().toLowerCase() : "";
    return NOTES_SEEN_KEY_PREFIX + position;
  }

  function getNotesLastSeen_() {
    return Number(localStorage.getItem(notesSeenKey_()) || 0);
  }

  /** Call when the Notes page has actually been viewed — see notes.html's load(). */
  function markNotesSeen_() {
    localStorage.setItem(notesSeenKey_(), String(Date.now()));
    const badge = document.getElementById("notes-nav-badge");
    if (badge) badge.style.display = "none";
  }

  function updateNotesBadge_(notes) {
    const badge = document.getElementById("notes-nav-badge");
    if (!badge) return;
    const session = Auth.getSession();
    const myPosition = session && session.Position ? String(session.Position).trim().toLowerCase() : "";
    if (!myPosition) { badge.style.display = "none"; return; }

    const lastSeen = getNotesLastSeen_();
    const unseenCount = notes.filter(n => {
      if (String(n.ToPosition || "").trim().toLowerCase() !== myPosition) return false;
      const t = new Date(n.Timestamp).getTime();
      return !isNaN(t) && t > lastSeen;
    }).length;

    if (unseenCount > 0) {
      badge.textContent = unseenCount > 9 ? "9+" : String(unseenCount);
      badge.style.display = "inline-block";
    } else {
      badge.style.display = "none";
    }
  }

  let announcementsPopoverEl_ = null;
  let announcementsOutsideHandler_ = null;
  let announcementsKeyHandler_ = null;

  /**
   * Announcement Message is rich-text HTML (see js/richtext.js), but this
   * popover is a plain-text preview shown on every page — not every page
   * loads richtext.js, so this strips tags down to plain text here rather
   * than pulling in the whole sanitizer just to re-escape it.
   */
  function messagePreviewText_(html) {
    const template = document.createElement("template");
    template.innerHTML = html || "";
    return template.content.textContent || "";
  }

  function renderAnnouncementsList_(entries) {
    return entries.length ? entries.map(e => `
      <div class="announcements-popover__item">
        <div class="announcements-popover__meta">${e.icon} ${escapeHtml_(e.title || "—")} · ${escapeHtml_(formatDateTime_(e.timestamp))}</div>
        <div class="announcements-popover__message">${escapeHtml_(e.body || "")}</div>
      </div>
    `).join("") : `<div class="announcements-popover__empty">No notifications yet.</div>`;
  }

  /** Keeps an already-OPEN popover's list live as fresh data arrives, instead of only updating it the next time it's opened. */
  function refreshOpenNotificationsPopover_() {
    if (!announcementsPopoverEl_) return;
    const listEl = announcementsPopoverEl_.querySelector(".announcements-popover__list");
    if (listEl) listEl.innerHTML = renderAnnouncementsList_(mergedNotificationEntries_());
  }

  function closeAnnouncementsPopover_() {
    if (announcementsPopoverEl_) {
      announcementsPopoverEl_.remove();
      announcementsPopoverEl_ = null;
    }
    if (announcementsOutsideHandler_) {
      document.removeEventListener("mousedown", announcementsOutsideHandler_, true);
      announcementsOutsideHandler_ = null;
    }
    if (announcementsKeyHandler_) {
      document.removeEventListener("keydown", announcementsKeyHandler_);
      announcementsKeyHandler_ = null;
    }
  }

  /**
   * Opens (or, if already open, closes) the Notifications popover — a
   * merged, reverse-chronological feed of Announcements and Notes sent
   * to me (see mergedNotificationEntries_). Reads from the SAME cached arrays
   * loadGlobalAlerts_ already keeps warm (Shell.init calls it on every
   * page), rather than re-fetching, so this renders instantly. Closes
   * on its own × button, an outside click, or Escape.
   */
  function toggleAnnouncementsPopover_() {
    if (announcementsPopoverEl_) {
      closeAnnouncementsPopover_();
      return;
    }

    const el = document.createElement("div");
    el.className = "announcements-popover";
    el.innerHTML = `
      <div class="announcements-popover__header">
        <span>Notifications</span>
        <button type="button" class="announcements-popover__close" aria-label="Close">&times;</button>
      </div>
      <div class="announcements-popover__list">
        ${renderAnnouncementsList_(mergedNotificationEntries_())}
      </div>
    `;
    document.body.appendChild(el);
    announcementsPopoverEl_ = el;

    // Anchor to the bell button's actual on-screen position rather than
    // a fixed top offset — the header's height varies (wraps on narrow
    // widths), and a fixed offset was overlapping the header buttons
    // instead of sitting below them.
    const bellBtnForPosition = document.getElementById("announcements-bell-btn");
    if (bellBtnForPosition) {
      const rect = bellBtnForPosition.getBoundingClientRect();
      el.style.top = `${Math.round(rect.bottom + 8)}px`;
      el.style.right = `${Math.round(window.innerWidth - rect.right)}px`;
    }

    el.querySelector(".announcements-popover__close").addEventListener("click", closeAnnouncementsPopover_);

    announcementsOutsideHandler_ = (e) => {
      const bellBtn = document.getElementById("announcements-bell-btn");
      if (el.contains(e.target) || (bellBtn && bellBtn.contains(e.target))) return;
      closeAnnouncementsPopover_();
    };
    announcementsKeyHandler_ = (e) => {
      if (e.key === "Escape") closeAnnouncementsPopover_();
    };
    // Wire outside-click on the NEXT tick so the same click that opened
    // the popover (the bell button click, which bubbles to document)
    // doesn't immediately close it again.
    setTimeout(() => {
      document.addEventListener("mousedown", announcementsOutsideHandler_, true);
      document.addEventListener("keydown", announcementsKeyHandler_);
    }, 0);
  }

  /**
   * Instant-then-revalidate: renders whatever's cached from a PRIOR
   * call immediately (usually nothing, the first time a page loads,
   * since this is a fresh page context each navigation — but matters a
   * lot for the periodic re-checks below, and for the fetch this same
   * function just triggered on the previous page before navigating
   * away, if the cache happened to survive... it generally won't in a
   * static multi-page app, but the pattern costs nothing when it
   * doesn't apply and helps whenever Api's cache IS warm, e.g. this
   * function's own repeated setInterval calls on the SAME page.
   */
  function loadGlobalAlerts_() {
    const announcementsCache = Api.getSheetCached("Announcements", (data) => {
      lastAnnouncementRows_ = data.rows || [];
      updateAnnouncementsBadge_();
      refreshOpenNotificationsPopover_();
      checkNewAnnouncements_(lastAnnouncementRows_);
    });
    const notesCache = Api.getSheetCached("Notes", (data) => {
      const rows = data.rows || [];
      updateNotesBadge_(rows);
      lastNotesToMeRows_ = notesToMe_(rows);
      updateAnnouncementsBadge_();
      refreshOpenNotificationsPopover_();
      checkNewNotes_(lastNotesToMeRows_);
    });

    if (announcementsCache.data) {
      lastAnnouncementRows_ = announcementsCache.data.rows || [];
      checkNewAnnouncements_(lastAnnouncementRows_);
    }
    if (notesCache.data) {
      const rows = notesCache.data.rows || [];
      updateNotesBadge_(rows);
      lastNotesToMeRows_ = notesToMe_(rows);
      checkNewNotes_(lastNotesToMeRows_);
    }
    updateAnnouncementsBadge_();

    // Always let the background fetches land too, even with no cache —
    // this covers the very first load, where getSheetCached() returned
    // null data but still kicked off the real request via `ready`.
    return Promise.all([announcementsCache.ready, notesCache.ready]).catch(() => {});
  }

  // Matches the two generic connectivity error messages js/api.js throws
  // from its request() helper (see "Network error reaching the server..."
  // and "Request timed out..." in js/api.js) — the messages a background
  // sheet revalidation (mountSheet/hardRefresh/warmCache/etc.) surfaces
  // when the device has no connection.
  const NETWORK_ERROR_MESSAGE_RE = /network error reaching the server|request timed out/i;

  function showToast(message, { type = "" } = {}) {
    // This app is deliberately offline-first: every page renders from
    // its persisted cache first and revalidates in the background (see
    // Api.getSheetCached), and the header's sync-indicator pill already
    // reads "Offline" the instant connectivity drops (wireSyncIndicator_
    // above). A background read failing because there's no connection
    // is an EXPECTED consequence of that design, not a real error — so
    // don't also pop a "Network error reaching the server" toast over
    // whatever's already on screen. Anything else (a genuine server-side
    // failure, a validation error, etc.) still shows as normal, online
    // or not.
    if (type === "error" && typeof navigator !== "undefined" && navigator.onLine === false && NETWORK_ERROR_MESSAGE_RE.test(message || "")) {
      return;
    }

    const existing = document.querySelector(".toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = `toast ${type ? `toast--${type}` : ""}`;
    toast.textContent = message;
    // Announce to assistive tech: errors interrupt (assertive), everything
    // else is polite. Without this, a screen-reader user gets no feedback
    // that a save landed or a sync failed — the toast is purely visual.
    if (type === "error") {
      toast.setAttribute("role", "alert");
      toast.setAttribute("aria-live", "assertive");
    } else {
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
    }
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 4000);
  }

  /**
   * A delete confirmation pattern used across every page that removes a
   * row (Roster/Schedule/Notes/Announcements/Observations/Inspection
   * Periods): instead of an upfront "are you sure?" dialog blocking the
   * action, the caller applies the removal to its own LOCAL state and
   * re-renders immediately, and this shows a toast with an "Undo" button
   * for `windowMs` (default 6s). `onCommit` — the actual
   * Api.deleteRow(...) call — only fires once the window elapses without
   * Undo being clicked; clicking Undo cancels it outright, so the row is
   * never actually deleted server-side. The caller is responsible for
   * restoring its own local state if Undo is clicked (pass that as
   * `onUndo`) — this function only owns the timer and the toast.
   *
   * This intentionally REPLACES the old "confirm, then delete
   * immediately, irreversibly" pattern for row deletes: a confirm dialog
   * only asks "are you sure" before anything happens, which is no help
   * against the far more common case of clicking Delete on the wrong
   * row. A brief, cancelable window after the fact solves that instead.
   */
  function showUndoToast(message, onCommit, { windowMs = 6000, onUndo = null } = {}) {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");

    const label = document.createElement("span");
    label.textContent = message;
    toast.appendChild(label);

    const undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.className = "toast__undo-btn";
    undoBtn.textContent = "Undo";
    toast.appendChild(undoBtn);

    document.body.appendChild(toast);

    let committed = false;
    const timer = setTimeout(() => {
      committed = true;
      toast.remove();
      onCommit();
    }, windowMs);

    undoBtn.addEventListener("click", () => {
      if (committed) return; // window already elapsed — nothing left to undo
      clearTimeout(timer);
      toast.remove();
      if (onUndo) onUndo();
    });
  }

  // ---- Custom tooltip (replaces native title="") ------------------------

  let tooltipEl_ = null;
  let tooltipsGloballyWired_ = false;
  function ensureTooltipEl_() {
    if (!tooltipEl_) {
      tooltipEl_ = document.createElement("div");
      tooltipEl_.className = "tooltip-bubble";
      document.body.appendChild(tooltipEl_);
    }
    if (!tooltipsGloballyWired_) {
      tooltipsGloballyWired_ = true;
      // A tooltip's trigger element can be torn out of the DOM (e.g. by an
      // innerHTML re-render inside its own click handler) without ever
      // firing mouseleave/blur, which would otherwise leave the bubble
      // stuck open. Hide on any click/scroll instead of relying solely on
      // the trigger's own events, and use the capture phase so this runs
      // before the click's own handler can replace the DOM.
      const hideAll = () => tooltipEl_ && tooltipEl_.classList.remove("is-visible");
      document.addEventListener("click", hideAll, true);
      document.addEventListener("scroll", hideAll, true);
    }
    return tooltipEl_;
  }

  function positionTooltip_(target) {
    const bubble = ensureTooltipEl_();
    const rect = target.getBoundingClientRect();
    // Prefer above the element; flip below if there's no room.
    const bubbleHeight = bubble.offsetHeight || 28;
    const above = rect.top - bubbleHeight - 8;
    const top = above > 4 ? above : rect.bottom + 8;
    let left = rect.left + rect.width / 2 - bubble.offsetWidth / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - bubble.offsetWidth - 4));
    bubble.style.top = `${Math.round(top)}px`;
    bubble.style.left = `${Math.round(left)}px`;
  }

  /**
   * Wires every [data-tooltip] element within `root` (defaults to the
   * whole document) to show a themed bubble on hover/focus instead of
   * the browser's native title="" tooltip, which is slow to appear and
   * can't be restyled. Safe to call repeatedly on the same subtree —
   * re-wiring an already-wired element is a no-op.
   */
  function wireTooltips_(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-tooltip]:not([data-tooltip-wired])").forEach((el) => {
      el.setAttribute("data-tooltip-wired", "true");
      const show = () => {
        const bubble = ensureTooltipEl_();
        bubble.textContent = el.getAttribute("data-tooltip");
        bubble.classList.add("is-visible");
        positionTooltip_(el);
      };
      const hide = () => {
        if (tooltipEl_) tooltipEl_.classList.remove("is-visible");
      };
      el.addEventListener("mouseenter", show);
      el.addEventListener("mouseleave", hide);
      el.addEventListener("focus", show);
      el.addEventListener("blur", hide);
      // Touch devices have no hover — don't leave a stuck tooltip open.
      el.addEventListener("touchstart", hide, { passive: true });
    });
  }

  // ---- Custom dropdown (replaces native <select>) -----------------------

  /**
   * Positions a `position: fixed`, body-appended floating panel (custom
   * dropdown menu / date field / time field popover) against its
   * trigger element. Appending to <body> and computing coordinates from
   * getBoundingClientRect() — rather than `position: absolute` nested
   * inside the trigger's own wrapper — is what lets these popovers
   * escape an ancestor with overflow:hidden (e.g. .card, used by every
   * form in the app), which otherwise clips them instead of letting
   * them float above the page. Flips above the trigger, and clamps
   * horizontally, whenever there isn't room below/right.
   */
  function positionFloatingPanel_(panel, anchorEl, { matchWidth = false } = {}) {
    const rect = anchorEl.getBoundingClientRect();
    if (matchWidth) panel.style.width = `${rect.width}px`;

    const panelHeight = panel.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openAbove = spaceBelow < panelHeight && rect.top > panelHeight;
    panel.style.top = `${Math.round(openAbove ? rect.top - panelHeight - 4 : rect.bottom + 4)}px`;

    const panelWidth = panel.offsetWidth;
    let left = rect.left;
    left = Math.max(4, Math.min(left, window.innerWidth - panelWidth - 4));
    panel.style.left = `${Math.round(left)}px`;
  }

  /**
   * Progressively enhances a native <select> into the themed custom
   * dropdown (see .dropdown/.dropdown__trigger/.dropdown__menu in
   * app.css) while keeping the underlying <select> as the source of
   * truth: its value stays in sync and a real "change" event still
   * fires on it, so existing code that reads selectEl.value or listens
   * for "change" keeps working untouched.
   *
   * Safe to call again on the same <select> after its options change
   * (e.g. after an async load repopulates it) — it tears down any
   * previous wrapper first.
   */
  function enhanceSelect(selectEl) {
    if (!selectEl) return null;

    const previous = selectEl.previousElementSibling;
    if (previous && previous.classList && previous.classList.contains("dropdown") && previous.dataset.forSelect === selectEl.id) {
      previous.remove();
    }

    selectEl.style.display = "none";

    const wrap = document.createElement("div");
    wrap.className = "dropdown";
    if (selectEl.id) wrap.dataset.forSelect = selectEl.id;

    const options = Array.from(selectEl.options);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "dropdown__trigger";
    trigger.disabled = selectEl.disabled;

    const label = document.createElement("span");
    const chevron = document.createElement("span");
    chevron.className = "dropdown__chevron";
    chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M6 9l6 6 6-6"/></svg>';
    trigger.append(label, chevron);

    const menu = document.createElement("div");
    menu.className = "dropdown__menu";
    menu.style.display = "none";

    function selectedOption() {
      return options.find(o => o.value === selectEl.value) || options.find(o => o.selected) || null;
    }

    function syncLabel() {
      const opt = selectedOption();
      if (!opt) { label.textContent = "Select…"; return; }
      // A middle dot reads as one label, not two clashing separators, when
      // the option's own text already contains its own em dash (e.g. an
      // inspection period's "Uniform — OCP/ABU") — see data-sublabel below.
      label.textContent = opt.dataset.sublabel ? `${opt.textContent} · ${opt.dataset.sublabel}` : opt.textContent;
    }

    function close() {
      wrap.classList.remove("is-open");
      menu.style.display = "none";
      if (menu.parentNode === document.body) document.body.removeChild(menu);
      document.removeEventListener("click", onOutsideClick, true);
      document.removeEventListener("keydown", onKeydown);
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    }

    function onReposition() {
      positionFloatingPanel_(menu, trigger, { matchWidth: true });
    }

    function open() {
      wrap.classList.add("is-open");
      document.body.appendChild(menu);
      menu.style.display = "block";
      positionFloatingPanel_(menu, trigger, { matchWidth: true });
      document.addEventListener("click", onOutsideClick, true);
      document.addEventListener("keydown", onKeydown);
      window.addEventListener("scroll", onReposition, true);
      window.addEventListener("resize", onReposition);
    }

    function onOutsideClick(e) {
      if (!wrap.contains(e.target) && !menu.contains(e.target)) close();
    }

    function onKeydown(e) {
      if (e.key === "Escape") close();
    }

    trigger.addEventListener("click", () => {
      if (trigger.disabled) return;
      if (wrap.classList.contains("is-open")) close(); else open();
    });

    options.forEach(opt => {
      if (opt.disabled) return;
      const row = document.createElement("div");
      row.className = "dropdown__option";
      row.setAttribute("role", "option");
      // An option can carry a data-sublabel (e.g. a date) to show as its
      // own smaller, muted line under the main text — instead of jamming
      // both onto one line with a separator that reads oddly whenever the
      // main text already has its own punctuation (see the Inspections
      // Trends "Showing:" dropdown, which sets this to a period's date).
      // Plain options (no sublabel) render exactly as before.
      if (opt.dataset.sublabel) {
        const primary = document.createElement("div");
        primary.textContent = opt.textContent;
        const sub = document.createElement("div");
        sub.className = "dropdown__option-sub";
        sub.textContent = opt.dataset.sublabel;
        row.append(primary, sub);
      } else {
        row.textContent = opt.textContent;
      }
      row.addEventListener("click", () => {
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
        syncLabel();
        close();
      });
      menu.appendChild(row);
    });

    wrap.append(trigger, menu);
    selectEl.parentNode.insertBefore(wrap, selectEl);
    syncLabel();

    return { refresh: () => enhanceSelect(selectEl), close };
  }

  // ---- Custom date field (replaces native <input type="date">) ----------
  //
  // Same progressive-enhancement idea as enhanceSelect: the native
  // input stays in the DOM (hidden) as the source of truth — its .value
  // is what code elsewhere still reads, and a real "change" event still
  // fires on it — while a themed trigger + calendar popover replace the
  // browser's own (unthemed, OS-styled) date picker UI.

  const MONTH_NAMES_ = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const WEEKDAY_ABBR_ = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  function isoFromParts_(y, m, d) { return `${y}-${pad2_(m + 1)}-${pad2_(d)}`; }

  function enhanceDateInput(inputEl) {
    if (!inputEl) return null;

    const previous = inputEl.previousElementSibling;
    if (previous && previous.classList && previous.classList.contains("date-field") && previous.dataset.forInput === inputEl.id) {
      previous.remove();
    }

    inputEl.style.display = "none";

    const wrap = document.createElement("div");
    wrap.className = "date-field";
    if (inputEl.id) wrap.dataset.forInput = inputEl.id;

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "date-field__trigger";
    trigger.innerHTML = `<span class="date-field__label"></span><span class="date-field__icon">${ICONS.calendar}</span>`;
    wrap.appendChild(trigger);
    inputEl.parentNode.insertBefore(wrap, inputEl);

    const labelEl = trigger.querySelector(".date-field__label");
    let viewYear, viewMonth; // 0-based month currently shown in the open panel
    let panelEl = null;
    let outsideHandler = null;

    function syncLabel() {
      if (inputEl.value) {
        const [y, m, d] = inputEl.value.split("-").map(Number);
        labelEl.textContent = `${MONTH_NAMES_[m - 1].slice(0, 3)} ${d}, ${y}`;
        labelEl.classList.remove("date-field__placeholder");
      } else {
        labelEl.textContent = "Select date";
        labelEl.classList.add("date-field__placeholder");
      }
    }
    syncLabel();

    function close() {
      if (panelEl) { panelEl.remove(); panelEl = null; }
      wrap.classList.remove("is-open");
      if (outsideHandler) { document.removeEventListener("mousedown", outsideHandler, true); outsideHandler = null; }
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    }

    function pick(iso) {
      inputEl.value = iso;
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
      syncLabel();
      close();
    }

    function renderPanel() {
      if (panelEl) panelEl.remove();

      const first = new Date(viewYear, viewMonth, 1);
      const startWeekday = first.getDay();
      const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
      const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();
      const todayIso = todayIso_();
      const selectedIso = inputEl.value;

      const cells = [];
      for (let i = 0; i < startWeekday; i++) {
        cells.push({ day: daysInPrevMonth - startWeekday + i + 1, muted: true });
      }
      for (let d = 1; d <= daysInMonth; d++) {
        cells.push({ day: d, muted: false, iso: isoFromParts_(viewYear, viewMonth, d) });
      }
      let trailing = 1;
      while (cells.length < 42) cells.push({ day: trailing++, muted: true });

      panelEl = document.createElement("div");
      panelEl.className = "date-field__panel";
      panelEl.innerHTML = `
        <div class="date-field__header">
          <button type="button" class="date-field__nav-btn" data-nav="-1" aria-label="Previous month">‹</button>
          <span>${MONTH_NAMES_[viewMonth]} ${viewYear}</span>
          <button type="button" class="date-field__nav-btn" data-nav="1" aria-label="Next month">›</button>
        </div>
        <div class="date-field__weekdays">
          ${WEEKDAY_ABBR_.map(w => `<span class="date-field__weekday">${w}</span>`).join("")}
        </div>
        <div class="date-field__days">
          ${cells.map(c => {
            if (c.muted) return `<span class="date-field__day is-muted">${c.day}</span>`;
            const classes = ["date-field__day"];
            if (c.iso === todayIso) classes.push("is-today");
            if (c.iso === selectedIso) classes.push("is-selected");
            return `<button type="button" class="${classes.join(" ")}" data-iso="${c.iso}">${c.day}</button>`;
          }).join("")}
        </div>
        <div class="date-field__footer">
          <button type="button" data-action="today">Today</button>
          ${inputEl.value ? `<button type="button" data-action="clear">Clear</button>` : "<span></span>"}
        </div>
      `;
      document.body.appendChild(panelEl);
      positionFloatingPanel_(panelEl, trigger);

      panelEl.querySelectorAll("[data-nav]").forEach(btn => {
        btn.addEventListener("click", () => {
          viewMonth += Number(btn.dataset.nav);
          if (viewMonth < 0) { viewMonth = 11; viewYear--; }
          if (viewMonth > 11) { viewMonth = 0; viewYear++; }
          renderPanel();
        });
      });
      panelEl.querySelectorAll("[data-iso]").forEach(btn => {
        btn.addEventListener("click", () => pick(btn.dataset.iso));
      });
      const todayBtn = panelEl.querySelector("[data-action='today']");
      if (todayBtn) todayBtn.addEventListener("click", () => pick(todayIso_()));
      const clearBtn = panelEl.querySelector("[data-action='clear']");
      if (clearBtn) clearBtn.addEventListener("click", () => pick(""));
    }

    function onReposition() {
      if (panelEl) positionFloatingPanel_(panelEl, trigger);
    }

    function open() {
      close();
      const base = inputEl.value ? new Date(inputEl.value + "T00:00:00") : new Date();
      viewYear = base.getFullYear();
      viewMonth = base.getMonth();
      renderPanel();
      wrap.classList.add("is-open");
      outsideHandler = (e) => { if (!wrap.contains(e.target) && (!panelEl || !panelEl.contains(e.target))) close(); };
      setTimeout(() => document.addEventListener("mousedown", outsideHandler, true), 0);
      window.addEventListener("scroll", onReposition, true);
      window.addEventListener("resize", onReposition);
    }

    trigger.addEventListener("click", () => {
      if (wrap.classList.contains("is-open")) close(); else open();
    });

    return { refresh: syncLabel, close };
  }

  // ---- Custom time field (replaces native <input type="time">) ----------
  //
  // Same progressive-enhancement approach, offering 15-minute
  // increments (0:00 through 23:45) — plenty of precision for a
  // schedule, and far simpler than reproducing a hardware-clock-style
  // scroll wheel.

  function enhanceTimeInput(inputEl) {
    if (!inputEl) return null;

    const previous = inputEl.previousElementSibling;
    if (previous && previous.classList && previous.classList.contains("time-field") && previous.dataset.forInput === inputEl.id) {
      previous.remove();
    }

    inputEl.style.display = "none";

    const wrap = document.createElement("div");
    wrap.className = "time-field";
    if (inputEl.id) wrap.dataset.forInput = inputEl.id;

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "time-field__trigger";
    trigger.innerHTML = `<span class="time-field__label"></span><span class="time-field__icon">${ICONS.clock}</span>`;
    wrap.appendChild(trigger);
    inputEl.parentNode.insertBefore(wrap, inputEl);

    const labelEl = trigger.querySelector(".time-field__label");
    let panelEl = null;
    let outsideHandler = null;

    function syncLabel() {
      if (inputEl.value) {
        labelEl.textContent = inputEl.value;
        labelEl.classList.remove("time-field__placeholder");
      } else {
        labelEl.textContent = "Select time";
        labelEl.classList.add("time-field__placeholder");
      }
    }
    syncLabel();

    const SLOTS = [];
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 15) SLOTS.push(`${pad2_(h)}:${pad2_(m)}`);
    }

    function close() {
      if (panelEl) { panelEl.remove(); panelEl = null; }
      wrap.classList.remove("is-open");
      if (outsideHandler) { document.removeEventListener("mousedown", outsideHandler, true); outsideHandler = null; }
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    }

    function onReposition() {
      if (panelEl) positionFloatingPanel_(panelEl, trigger);
    }

    function open() {
      close();
      panelEl = document.createElement("div");
      panelEl.className = "time-field__panel";
      panelEl.innerHTML = SLOTS.map(t => `<button type="button" class="time-field__option ${t === inputEl.value ? "is-selected" : ""}" data-time="${t}">${t}</button>`).join("");
      document.body.appendChild(panelEl);
      positionFloatingPanel_(panelEl, trigger);
      wrap.classList.add("is-open");

      panelEl.querySelectorAll("[data-time]").forEach(btn => {
        btn.addEventListener("click", () => {
          inputEl.value = btn.dataset.time;
          inputEl.dispatchEvent(new Event("change", { bubbles: true }));
          syncLabel();
          close();
        });
      });

      const selected = panelEl.querySelector(".is-selected");
      if (selected) selected.scrollIntoView({ block: "center" });

      outsideHandler = (e) => { if (!wrap.contains(e.target) && !panelEl.contains(e.target)) close(); };
      setTimeout(() => document.addEventListener("mousedown", outsideHandler, true), 0);
      window.addEventListener("scroll", onReposition, true);
      window.addEventListener("resize", onReposition);
    }

    trigger.addEventListener("click", () => {
      if (wrap.classList.contains("is-open")) close(); else open();
    });

    return { refresh: syncLabel, close };
  }

  // ---- Custom context menu (replaces native right-click menu) -----------

  let contextMenuEl_ = null;

  function closeContextMenu_() {
    if (contextMenuEl_) {
      contextMenuEl_.remove();
      contextMenuEl_ = null;
      document.removeEventListener("click", closeContextMenu_, true);
      document.removeEventListener("keydown", onContextMenuKeydown_);
    }
  }

  function onContextMenuKeydown_(e) {
    if (e.key === "Escape") closeContextMenu_();
  }

  /**
   * Opens a themed context menu (see .context-menu in app.css) anchored
   * at the given point. items is an array of either:
   *   { label, icon: '<svg>...</svg>', onSelect: fn, danger: true|false }
   *   or the string "divider" for a separator line.
   * Usage: el.addEventListener("contextmenu", (e) => {
   *   e.preventDefault();
   *   Shell.openContextMenu(e.clientX, e.clientY, [...items]);
   * });
   */
  function openContextMenu(x, y, items) {
    closeContextMenu_();

    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.style.position = "fixed";
    menu.style.zIndex = "var(--z-overlay)";

    items.forEach(item => {
      if (item === "divider") {
        const divider = document.createElement("div");
        divider.className = "context-menu__divider";
        menu.appendChild(divider);
        return;
      }
      const row = document.createElement("div");
      row.className = "context-menu__item" + (item.danger ? " context-menu__item--danger" : "");
      row.innerHTML = `${item.icon || ""}<span>${item.label}</span>`;
      row.addEventListener("click", () => {
        closeContextMenu_();
        if (item.onSelect) item.onSelect();
      });
      menu.appendChild(row);
    });

    document.body.appendChild(menu);

    // Clamp so the menu never renders off the right/bottom edge.
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(4, left)}px`;
    menu.style.top = `${Math.max(4, top)}px`;

    contextMenuEl_ = menu;
    setTimeout(() => document.addEventListener("click", closeContextMenu_, true), 0);
    document.addEventListener("keydown", onContextMenuKeydown_);
  }

  // ---- Custom modal (replaces native confirm()) -------------------------

  /**
   * Keeps keyboard focus inside a modal (`container`) while it's open, and
   * returns a release() that restores focus to whatever had it before the
   * modal opened. Without this, Tab from inside a "blocking" dialog escapes
   * to the page behind it — and closing the dialog leaves focus orphaned on
   * a now-removed element instead of back on the control that opened it.
   */
  function getFocusable_(container) {
    return Array.from(container.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement);
  }

  function trapFocus_(container) {
    const previouslyFocused = document.activeElement;
    function onKeydown(e) {
      if (e.key !== "Tab") return;
      const focusable = getFocusable_(container);
      if (!focusable.length) { e.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }
    container.addEventListener("keydown", onKeydown);
    return function release() {
      container.removeEventListener("keydown", onKeydown);
      if (previouslyFocused && typeof previouslyFocused.focus === "function" && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }

  /**
   * Themed replacement for window.confirm(). Returns a Promise<boolean>
   * — true if the person confirmed, false if they cancelled or
   * dismissed. Usage: if (await Shell.confirm({ message: "..." })) { ... }
   */
  function confirmDialog({ title = "Are you sure?", message = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = true } = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML = `
        <div class="modal-card" role="alertdialog" aria-modal="true" aria-labelledby="modal-title">
          <div class="modal-card__icon ${danger ? "modal-card__icon--danger" : "modal-card__icon--info"}">${danger ? "!" : "i"}</div>
          <h3 id="modal-title">${title}</h3>
          <p>${message}</p>
          <div class="modal-card__actions">
            <button class="btn btn--ghost" id="modal-cancel-btn">${cancelLabel}</button>
            <button class="btn ${danger ? "btn--danger" : "btn--primary"}" id="modal-confirm-btn">${confirmLabel}</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const releaseFocus = trapFocus_(overlay);

      const cleanup = (result) => {
        document.removeEventListener("keydown", onKeydown);
        releaseFocus();
        overlay.remove();
        resolve(result);
      };

      const onKeydown = (e) => {
        if (e.key === "Escape") cleanup(false);
        if (e.key === "Enter") cleanup(true);
      };
      document.addEventListener("keydown", onKeydown);

      overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(false); });
      document.getElementById("modal-cancel-btn").addEventListener("click", () => cleanup(false));
      document.getElementById("modal-confirm-btn").addEventListener("click", () => cleanup(true));
      const confirmBtn = document.getElementById("modal-confirm-btn");
      // preventScroll stops the browser from scrolling .modal-card's own
      // overflow-y:auto (and, on mobile, the page itself) to reveal a
      // button below the fold — on a tall message this opened the modal
      // already scrolled to the actions row instead of the title. The
      // scrollTop reset below is a belt-and-suspenders fallback for
      // browsers that don't support preventScroll.
      confirmBtn.focus({ preventScroll: true });
      overlay.querySelector(".modal-card").scrollTop = 0;
    });
  }

  /**
   * Informational modal — for content that's purely "here's some
   * information, acknowledge it" (e.g. the iOS install instructions) or
   * "here's some information, then take this one action" (e.g. the CSV-
   * format-help modals on Roster/Schedule, which proceed into a file
   * picker), where Shell.confirm()'s yes/no framing (and boolean return
   * value) wouldn't make sense. Reuses the same themed .modal-card/
   * .modal-overlay as confirmDialog. bodyHtml is trusted markup from
   * this file, not user input — callers must escape any dynamic values
   * themselves before interpolating them in.
   *
   * onClose fires ONLY when the primary (closeLabel) button is actually
   * clicked — outside-click, Escape, and the optional cancelLabel button
   * all just dismiss the modal with no callback, the same confirm-vs-
   * cancel distinction Shell.confirm() already makes. A caller wiring
   * onClose to a real side effect (e.g. opening a file picker) would
   * otherwise have that effect fire on EVERY way of leaving the modal,
   * including ones meant to back out of it entirely.
   */
  function showInfoModal_({ title = "", bodyHtml = "", closeLabel = "Got it", cancelLabel = null, onClose } = {}) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="info-modal-title">
        <div class="modal-card__icon modal-card__icon--info">i</div>
        <h3 id="info-modal-title">${title}</h3>
        <div class="modal-card__body">${bodyHtml}</div>
        <div class="modal-card__actions">
          ${cancelLabel ? `<button class="btn btn--ghost" id="info-modal-cancel-btn">${cancelLabel}</button>` : ""}
          <button class="btn btn--primary" id="info-modal-close-btn">${closeLabel}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const releaseFocus = trapFocus_(overlay);

    let closed = false;
    /** Always dismisses; only calls onClose when `confirmed` (the primary button, or Enter). */
    const dismiss = (confirmed) => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKeydown);
      releaseFocus();
      overlay.remove();
      if (confirmed && onClose) onClose();
    };
    const onKeydown = (e) => {
      if (e.key === "Escape") dismiss(false);
      if (e.key === "Enter") dismiss(true);
    };
    document.addEventListener("keydown", onKeydown);

    overlay.addEventListener("click", (e) => { if (e.target === overlay) dismiss(false); });
    const cancelBtn = document.getElementById("info-modal-cancel-btn");
    if (cancelBtn) cancelBtn.addEventListener("click", () => dismiss(false));
    document.getElementById("info-modal-close-btn").addEventListener("click", () => dismiss(true));
    // preventScroll stops the browser from scrolling .modal-card's own
    // overflow-y:auto (and, on mobile, the page itself) to reveal a
    // button below the fold — on a long body (e.g. the CSV-format-help
    // table) this opened the modal already scrolled to the actions row
    // instead of the title/body content. The scrollTop reset below is a
    // belt-and-suspenders fallback for browsers without preventScroll.
    document.getElementById("info-modal-close-btn").focus({ preventScroll: true });
    overlay.querySelector(".modal-card").scrollTop = 0;
  }

  // ---- Blocking "new alert" popup (announcements) -----------------------

  let alertModalQueue_ = [];
  let alertModalShowing_ = false;

  /**
   * Full-screen, blurred, non-dismissible-except-by-button popup for a
   * genuinely NEW announcement (see checkNewAnnouncements_ below) —
   * deliberately has no outside-click or Escape close, unlike Shell.confirm(), since
   * this needs a deliberate acknowledgment. Multiple alerts queue and
   * show one at a time rather than stacking.
   */
  function showNextAlertModal_() {
    if (!alertModalQueue_.length) { alertModalShowing_ = false; return; }
    alertModalShowing_ = true;
    const config = alertModalQueue_.shift();

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-card" role="alertdialog" aria-modal="true">
        <div class="modal-card__icon ${config.danger ? "modal-card__icon--danger" : "modal-card__icon--info"}">${config.icon}</div>
        <h3>${config.title}</h3>
        <p>${config.bodyHtml}</p>
        <div class="modal-card__actions">
          <button class="btn btn--primary" id="alert-modal-dismiss-btn">Dismiss</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const releaseFocus = trapFocus_(overlay);

    document.getElementById("alert-modal-dismiss-btn").addEventListener("click", () => {
      releaseFocus();
      overlay.remove();
      showNextAlertModal_();
    });
    // See showInfoModal_'s matching comment — focusing the dismiss
    // button below the fold otherwise scrolls a long body straight to
    // the bottom before the user sees the top.
    document.getElementById("alert-modal-dismiss-btn").focus({ preventScroll: true });
    overlay.querySelector(".modal-card").scrollTop = 0;
  }

  // A popup for something that happened while nobody was actually
  // looking at the tab is easy to miss entirely (a background tab's
  // modal doesn't grab attention the way a foreground one does, and on
  // some browsers a hidden tab's rendering is throttled/suspended
  // altogether) — so a genuinely new alert queues normally but only
  // actually SHOWS once the tab is visible; visibilitychange flushes
  // the queue the moment someone comes back to look.
  function enqueueAlertModal_(config) {
    alertModalQueue_.push(config);
    if (!alertModalShowing_ && document.visibilityState === "visible") showNextAlertModal_();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !alertModalShowing_ && alertModalQueue_.length) {
      showNextAlertModal_();
    }
  });

  /**
   * Compares fresh Announcements rows against this POSITION's last-known
   * timestamp and pops the alert modal for the newest one if it's
   * genuinely new. The very first time this ever runs for a position
   * (key absent), it just seeds the baseline silently — otherwise every
   * fresh sign-in would immediately alert for the entire backlog.
   */
  function checkNewAnnouncements_(rows) {
    const key = positionScopedKey_(LAST_KNOWN_ANNOUNCEMENT_TS_KEY_PREFIX);
    const stored = localStorage.getItem(key);
    const lastKnownTs = Number(stored || 0);
    const isFirstRun = stored === null;

    let maxTs = lastKnownTs;
    let newest = null;
    rows.forEach((a) => {
      const t = new Date(a.Timestamp).getTime();
      if (!isNaN(t) && t > maxTs) { maxTs = t; newest = a; }
    });

    if (newest && !isFirstRun) {
      enqueueAlertModal_({
        icon: "📣",
        title: "New Announcement",
        bodyHtml: `<strong>${escapeHtml_(newest.Position || "Staff")}</strong><br>${escapeHtml_(messagePreviewText_(newest.Message || ""))}`
      });
    }
    if (maxTs !== lastKnownTs || isFirstRun) localStorage.setItem(key, String(maxTs));
  }

  // A checkBlackFlagChange_ function used to live here — same idea as
  // checkNewAnnouncements_ above, but for BlackFlagStatus (a single row
  // rather than a growing list, so it compared an Active+UpdatedAt
  // "signature" instead of a timestamp) — removed from the frontend
  // pending a future pass. The BlackFlagStatus sheet and the Worker's
  // support for it are untouched; see the comment on the Announcements-
  // bell section above.

  /** Same idea again, for Notes addressed directly to this position. `rows` is already pre-filtered to just those (see notesToMe_). */
  function checkNewNotes_(rows) {
    const key = positionScopedKey_(LAST_KNOWN_NOTE_TS_KEY_PREFIX);
    const stored = localStorage.getItem(key);
    const lastKnownTs = Number(stored || 0);
    const isFirstRun = stored === null;

    let maxTs = lastKnownTs;
    let newest = null;
    rows.forEach((n) => {
      const t = new Date(n.Timestamp).getTime();
      if (!isNaN(t) && t > maxTs) { maxTs = t; newest = n; }
    });

    if (newest && !isFirstRun) {
      enqueueAlertModal_({
        icon: "📝",
        title: "New Note Sent To You",
        bodyHtml: `<strong>${escapeHtml_(newest.AuthorPosition || "Staff")}</strong>${newest.Subject ? `<br>${escapeHtml_(newest.Subject)}` : ""}`
      });
    }
    if (maxTs !== lastKnownTs || isFirstRun) localStorage.setItem(key, String(maxTs));
  }

  function wireIdleTimeout() {
    const markActive = () => Auth.touchActivity();
    ["click", "keydown", "touchstart", "scroll"].forEach((evt) =>
      window.addEventListener(evt, markActive, { passive: true })
    );

    const checkIdle = () => {
      const hadSession = !!Auth.getSession();
      Auth.enforceIdleTimeout();
      const hasSessionNow = !!Auth.getSession();
      if (hadSession && !hasSessionNow) {
        const returnTo = encodeURIComponent(window.location.pathname);
        window.location.href = `${window.APP_BASE_PATH}index.html?returnTo=${returnTo}`;
      }
    };

    setInterval(checkIdle, 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkIdle();
    });
  }

  /**
   * Call at the top of every protected page's script, passing that
   * page's own nav id, e.g. Shell.requirePageAccess('schedule'). No
   * page id is exempt — including 'roster'. Redirects to the first
   * page this position IS allowed to see (or back to login if none).
   */
  function requirePageAccess(pageId) {
    const allowedSet = getAllowedPageIds();
    if (pageId && allowedSet.has(pageId.toLowerCase())) return true;

    showToast("You don't have access to that page.", { type: "error" });

    const allowedItems = getAllowedNavItems();
    if (allowedItems.length > 0) {
      window.location.href = `${window.APP_BASE_PATH}${allowedItems[0].href}`;
    } else {
      window.location.href = `${window.APP_BASE_PATH}index.html`;
    }
    throw new Error("Page access denied — redirecting.");
  }

  /**
   * Adds a "Skip to content" link as the first focusable element on the
   * page (hidden off-screen until focused — see .skip-link in app.css) so
   * a keyboard/screen-reader user can jump past the nav rail's 7-9 links
   * straight to the page's main content. Targets the <main class="app-main">
   * element, made programmatically focusable via tabindex="-1".
   */
  function injectSkipLink_() {
    const main = document.querySelector(".app-main");
    if (main && !main.id) {
      main.id = "main-content";
      main.setAttribute("tabindex", "-1");
    }
    if (document.querySelector(".skip-link")) return;
    const link = document.createElement("a");
    link.className = "skip-link";
    link.href = "#main-content";
    link.textContent = "Skip to content";
    document.body.insertBefore(link, document.body.firstChild);
  }

  /**
   * A small attribution/contact note appended to the bottom of every
   * page's main content, right after Shell.init() places it there.
   * Appended (not part of a page's own #page-content) so it survives
   * every innerHTML re-render the page itself does.
   */
  function renderFooterNote_() {
    const main = document.querySelector(".app-main");
    if (!main || document.getElementById("app-footer-note")) return;
    const footer = document.createElement("footer");
    footer.id = "app-footer-note";
    footer.className = "app-footer-note";
    footer.textContent = "This app was built and is maintained by the Innovations and Technology Department. Direct questions, comments, or concerns to the Innovations and Technology Department.";
    main.appendChild(footer);
  }

  /**
   * Call once per page. Pass { activePage: 'schedule' | 'roster' | ... , requireAuth: true }
   */
  function init({ activePage = null, requireAuth = true } = {}) {
    activePage_ = activePage;
    if (requireAuth) Auth.requireSession();
    if (requireAuth && activePage) requirePageAccess(activePage);
    // Unconditional (like the skip-link below) — theme is a visual
    // preference independent of auth, and registers the live OS-change
    // listener for a "system" preference for the rest of this page's life.
    initThemeWatcher_();
    injectSkipLink_();
    renderFooterNote_();
    // Skip if Shell.renderNav(activePage) already ran earlier in this
    // same page load (see the inline script right after #nav-rail in
    // every page's markup) — otherwise the sidebar links get torn down
    // and rebuilt a second time for no visible difference.
    if (navRenderedForPage_ !== activePage) renderNav(activePage);
    renderHeader(activePage);
    wireTooltips_(document);
    // Unconditional (not gated on requireAuth) since every page THAT CALLS
    // Shell.init() should offer this, regardless of whether it also
    // requires a session — but note gate.html doesn't load shell.js at all,
    // and index.html loads it without ever calling init(), so neither of
    // those two brief, transitional pre-auth screens gets this prompt. That's
    // fine in practice: they're quick full-page-reload steps a person passes
    // through on the way in, not somewhere a mid-session deploy would
    // meaningfully interrupt anything.
    initUpdatePrompt_();
    // Set by initUpdatePrompt_ right before the silent, no-confirmation
    // reload it does on a real service worker update — sessionStorage
    // (not a variable) survives exactly that reload and nothing more,
    // so this fires once, on the very next page, then never again until
    // another real update happens.
    try {
      if (sessionStorage.getItem("njwg_just_auto_updated")) {
        sessionStorage.removeItem("njwg_just_auto_updated");
        showToast("Updated to the latest version.");
      }
    } catch (e) { /* ignore */ }
    // Rotating the device mid-scroll leaves the browser holding onto the
    // OLD scrollY against the NEW (shorter or taller) reflowed layout —
    // landscape's shorter content can end up entirely above the
    // preserved scroll position (a blank gap until manually scrolled back
    // up), and the reverse rotation to portrait can leave the page NOT
    // at its own top despite otherwise looking done loading. Snapping
    // scroll back to 0 on every orientation change sidesteps both
    // directions of this well-known mobile viewport quirk.
    window.addEventListener("orientationchange", () => window.scrollTo(0, 0));
    // Global search keyboard shortcut (Ctrl+K / ⌘+K), available on every
    // page with a physical keyboard — this app also runs on touch-only
    // tablets/phones with no keyboard at all, where this listener simply
    // never fires and the search button (aria-label "Search", no shortcut
    // mentioned) remains the only, fully sufficient way in.
    if (requireAuth) {
      document.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
          e.preventDefault();
          openSearch_();
        }
      });
    }
    if (requireAuth) {
      wireIdleTimeout();
      loadGlobalAlerts_();
      initFlightColorSync_();
      // Replay any writes queued while offline — now (in case this page
      // loaded back online) and whenever the tab is refocused.
      if (Api.flushOutbox) {
        Api.flushOutbox();
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") Api.flushOutbox();
        });
      }
      // Best-effort: reveal the "enable alerts" button if this device
      // supports push and the backend has it configured.
      initPush_();
      // Same idea for the "Install app" button — see the section above.
      initInstallPrompt_();
      // Keep the banner/badge reasonably fresh without a full reload —
      // but ONLY while this tab is actually visible. A backgrounded or
      // hidden tab left open all day would otherwise keep polling the
      // Worker every couple of minutes for no one to see, which is pure
      // wasted Worker invocations / bandwidth (and, at a few dozen
      // always-open staff devices, the dominant steady-state cost). The
      // visibilitychange handler below re-polls the instant the tab is
      // refocused, so freshness on return is unaffected; Web Push covers
      // the app-fully-closed case.
      setInterval(() => {
        if (document.visibilityState === "visible") loadGlobalAlerts_();
      }, 2 * 60 * 1000);
      // Warm every sheet reachable from a page THIS position can open (not
      // just the current page) — so by the time someone clicks to another
      // page, its data is already sitting in the persisted cache and
      // renders instantly instead of making them wait on the network
      // again. Api.warmCache now pulls all of these in a SINGLE batchRead
      // request rather than one read per sheet. Kept deliberately
      // infrequent, and gated on visibility (same reasoning as the alert
      // poll above — a hidden tab isn't about to navigate anywhere).
      const prefetchSheets = accessiblePrefetchSheets_();
      Api.warmCache(prefetchSheets);
      setInterval(() => {
        if (document.visibilityState === "visible") Api.warmCache(prefetchSheets);
      }, 3 * 60 * 1000);
      // Refresh alerts the moment the tab is refocused, so coming back to
      // a tab that was hidden for a while shows current data immediately
      // rather than waiting up to the poll interval above.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") loadGlobalAlerts_();
      });
    }
  }

  // ---- Content entrance animation (in-page view swaps) ------------------
  //
  // Every page replaces a container's whole innerHTML on nearly every
  // interaction (switching flights, filtering the roster, opening a
  // scorecard) — previously an instant pop-in. Call this right after
  // setting that innerHTML so the new content rises/fades in instead.
  // Safe to call repeatedly on the SAME element (e.g. re-rendering the
  // same view after a background refresh): removing the class and
  // forcing a reflow before re-adding it restarts the animation rather
  // than silently no-op'ing because the class never actually changed.

  function animateIn(el) {
    if (!el) return;
    el.classList.remove("view-fade-in");
    void el.offsetWidth; // force reflow
    el.classList.add("view-fade-in");
  }

  // ---- Tabs: animated sliding active-tab indicator -----------------------
  //
  // Progressively enhances a .tabs container (Uniform/Room/Trends,
  // Staff Access/Login Activity, etc.) with a single positioned element
  // that slides/resizes to sit behind the active .tabs__tab, instead of
  // each tab's own background appearing/disappearing instantly when
  // .is-active is toggled. The page itself still owns click handling and
  // toggling .is-active — call the returned `.move()` right after that,
  // so the indicator catches up to wherever the newly-active tab is.
  // Safe to call again on the same container (e.g. after its tabs are
  // re-rendered from scratch) — reuses the existing indicator if the
  // container still has one.
  function enhanceTabs(container) {
    if (!container) return null;
    container.classList.add("tabs--enhanced");
    wireTabsScroll_(container);

    let indicator = container.querySelector(":scope > .tabs__indicator");
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "tabs__indicator";
      container.insertBefore(indicator, container.firstChild);
    }

    function move() {
      const active = container.querySelector(".tabs__tab.is-active");
      if (!active) { indicator.style.opacity = "0"; return; }
      indicator.style.opacity = "1";
      indicator.style.width = `${active.offsetWidth}px`;
      indicator.style.left = `${active.offsetLeft}px`;
      // The active tab can be scrolled out of view (e.g. clicked via
      // keyboard, or newly active after a re-render) — bring it back
      // into the visible portion of the strip so the indicator is
      // never sitting off-screen. Adjusting THIS container's own
      // scrollLeft directly (rather than active.scrollIntoView, which
      // was used here previously) keeps this strictly horizontal and
      // scoped to the tab strip itself — scrollIntoView walks every
      // scrollable ancestor, including the page, and would happily
      // scroll the WHOLE PAGE vertically to satisfy block: "nearest"
      // whenever a tall page put this tab bar below the fold on first
      // render (e.g. pages/recommendations.html's admin-only add-entry
      // card pushing the submissions-review tab bar down) — the
      // "jumps to the middle of the page on load" bug this replaces.
      const containerRect = container.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      if (activeRect.left < containerRect.left) {
        container.scrollLeft -= (containerRect.left - activeRect.left);
      } else if (activeRect.right > containerRect.right) {
        container.scrollLeft += (activeRect.right - containerRect.right);
      }
    }

    move();
    window.addEventListener("resize", move);
    return { move };
  }

  /**
   * A .tabs bar scrolls horizontally (see the CSS comment in
   * css/app.css) once it has more tabs than fit — but touch/trackpad
   * panning aside, a plain mouse has no built-in way to pan a
   * horizontally-scrolling element. This adds click-and-drag scrolling
   * (like a "grab" scroller) plus lets a normal vertical mouse-wheel
   * scroll it horizontally, so it's actually usable with a mouse.
   * Idempotent — safe to call repeatedly on the same container (e.g.
   * every enhanceTabs call after a re-render).
   */
  function wireTabsScroll_(container) {
    if (container.dataset.dragScrollWired) return;
    container.dataset.dragScrollWired = "true";

    let isDown = false;
    let dragged = false;
    let startX = 0;
    let startScrollLeft = 0;

    container.addEventListener("mousedown", (e) => {
      isDown = true;
      dragged = false;
      startX = e.pageX;
      startScrollLeft = container.scrollLeft;
      container.classList.add("is-dragging");
    });

    const stopDrag = () => {
      isDown = false;
      container.classList.remove("is-dragging");
    };
    container.addEventListener("mouseleave", stopDrag);
    window.addEventListener("mouseup", stopDrag);

    container.addEventListener("mousemove", (e) => {
      if (!isDown) return;
      const delta = e.pageX - startX;
      if (Math.abs(delta) > 4) dragged = true;
      container.scrollLeft = startScrollLeft - delta;
    });

    // A drag that moved the strip shouldn't also register as a tab
    // click on whatever button the cursor happened to end up over.
    container.addEventListener("click", (e) => {
      if (dragged) { e.stopPropagation(); e.preventDefault(); }
    }, true);

    container.addEventListener("wheel", (e) => {
      if (container.scrollWidth <= container.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      container.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }

  return {
    init, renderNav, showToast, encampmentDayInfo, requirePageAccess, getAllowedNavItems,
    markAnnouncementsSeen: markAnnouncementsSeen_, refreshGlobalAlerts: loadGlobalAlerts_,
    markNotesSeen: markNotesSeen_,
    confirm: confirmDialog, wireTooltips: wireTooltips_, registerRefresh, hardRefresh,
    mountSheet, escapeHtml: escapeHtml_,
    enhanceSelect, enhanceDateInput, enhanceTimeInput, openContextMenu,
    registerExport, exportCsv, openSearch: openSearch_,
    currentAndNextScheduleItems, parseScheduleTime: parseScheduleTime_,
    flightMatchesAudience: flightMatchesAudience_,
    flightColor: flightColor_, flightColorTint: flightColorTint_, refreshFlightColors: refreshFlightColors_,
    isAtsFlight: isAtsFlight_,
    cadetDisplayName: cadetDisplayName_, isStaffRosterRow: isStaffRosterRow_,
    rosterNameMatches: rosterNameMatches_, normalizeRosterRows: normalizeRosterRows_,
    isScheduleRowToday: isScheduleRowToday_, todayIso: todayIso_,
    formatDateTime: formatDateTime_, formatTime: formatTime_,
    formatRelativeTime: formatRelativeTime_,
    showUndoToast, parseCsv, pickAndParseCsv,
    showInfoModal: showInfoModal_,
    animateIn, enhanceTabs
  };
})();
