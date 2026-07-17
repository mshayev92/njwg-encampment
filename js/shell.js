/* ============================================================
   NJWG ENCAMPMENT — APP SHELL RENDERER
   Builds the header, nav rail, black flag banner, and announcements
   bell. Every page includes a skeleton like:

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
    install:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="3"/><path d="M12 8v6M9 11h6"/><path d="M11 18h2"/></svg>'
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
  // a genuinely NEW announcement/black-flag/note-to-me since the last
  // poll (on any page), so the blocking alert popup fires once per new
  // arrival instead of replaying the whole backlog on every page load.
  const LAST_KNOWN_ANNOUNCEMENT_TS_KEY_PREFIX = "njwg_last_known_announcement_ts_";
  const LAST_KNOWN_BLACKFLAG_SIGNATURE_KEY_PREFIX = "njwg_last_known_blackflag_signature_";
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

  // Set once by init() — lets the black flag banner/pill logic (and
  // anything else that cares) know which page is currently showing
  // without threading the value through every function signature.
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
   * The set of sheets worth warming for THIS position: every sheet read by
   * a page it's actually allowed to see (APP_CONFIG.PAGE_SHEETS), plus the
   * always-on global sheets the header bell reads on every page
   * (GLOBAL_SHEETS). This is what's handed to Api.warmCache instead of the
   * full PREFETCH_SHEETS, so a position never spends background reads
   * warming sheets behind pages it can't open. Falls back to the full
   * PREFETCH_SHEETS if PAGE_SHEETS isn't configured, so nothing regresses.
   */
  function accessiblePrefetchSheets_() {
    const cfg = window.APP_CONFIG || {};
    const pageSheets = cfg.PAGE_SHEETS || {};
    if (!Object.keys(pageSheets).length) return cfg.PREFETCH_SHEETS || [];

    const allowed = getAllowedPageIds();
    const set = new Set(cfg.GLOBAL_SHEETS || []);
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
    if (crestBtn) crestBtn.addEventListener("click", toggleNavCollapsed_);
  }

  function renderHeader(activePage) {
    const header = document.getElementById("app-header");
    if (!header) return;

    const session = Auth.getSession();
    const navItem = (window.APP_CONFIG.NAV_ITEMS || []).find(i => i.id === activePage);
    const title = navItem ? navItem.label : window.APP_CONFIG.UNIT_NAME;

    const positionLabel = session ? (session.Position || session.position || "Staff") : "";

    header.innerHTML = `
      <h1 class="app-header__title">${title}</h1>
      <div class="app-header__user">
        ${session ? `
          <span id="black-flag-pill" class="black-flag-pill" style="display:none;">⚑ Black Flag</span>
          <span id="sync-indicator" class="sync-indicator sync-indicator--synced">
            <span class="sync-indicator__dot"></span>
            <span id="sync-indicator__label">Synced</span>
          </span>
          <button class="btn btn--ghost" id="global-search-btn" data-tooltip="Search (⌘/Ctrl-K)" aria-label="Search" style="padding: var(--space-2);">
            <span style="width:18px;height:18px;display:inline-flex;">${ICONS.search}</span>
          </button>
          <button class="btn btn--ghost app-header__bell" id="announcements-bell-btn" style="position: relative; padding: var(--space-2);" data-tooltip="Notifications" aria-label="Notifications">
            <span style="width:18px;height:18px;display:inline-flex;">${ICONS.bell}</span>
            <span id="announcements-badge" style="display:none; position:absolute; top:2px; right:2px; background:var(--red-600); color:#fff; border-radius:999px; font-size:10px; line-height:1; padding:3px 5px; font-family:var(--font-mono);"></span>
          </button>
          <div class="profile-menu-wrap">
            <button class="btn btn--ghost profile-menu__trigger" id="profile-menu-btn" aria-haspopup="true" aria-expanded="false" data-tooltip="Account">
              <span class="profile-menu__label">${escapeHtml_(positionLabel)}</span>
            </button>
            <div class="profile-menu" id="profile-menu" hidden>
              <button class="profile-menu__item" id="hard-refresh-btn" data-tooltip="Refresh all data now">
                <span class="spinner spinner--sm btn__spinner" id="hard-refresh-spinner" style="display:none;"></span>
                <span class="profile-menu__item-icon hard-refresh-icon" aria-hidden="true">${ICONS.refresh}</span>
                <span id="hard-refresh-label">Refresh</span>
              </button>
              <button class="profile-menu__item" id="export-btn" style="display:none;">
                <span class="profile-menu__item-icon">${ICONS.download}</span>
                <span>Export CSV</span>
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
      // feed (Announcements + Black Flag + Notes sent to me), which the
      // standalone Announcements page doesn't show.
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
    if (logoutBtn) logoutBtn.addEventListener("click", () => Auth.logout());

    wireProfileMenu_();
    wireSyncIndicator_();
    wireTooltips_(header);
  }

  // ---- Profile menu (top-right — replaces the old nav-rail "signed in
  // as" footer card). Holds Refresh/Export/Install/Enable-alerts/Log out
  // behind the position-name button so the always-visible header row
  // stays just the black flag pill, sync indicator, search, and
  // notifications bell. ----

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
      fields: ["Name", "CapId", "Rank", "Flight"],
      title: (r) => r.Name || r.CapId || "—",
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

        const haystack = src.fields
          ? src.fields.map((f) => row[f]).join(" ")
          : Object.values(row).join(" ");
        if (String(haystack).toLowerCase().includes(q)) {
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
  // Real Web Push so a staff device gets a New Announcement / Black Flag
  // alert even when the app is closed or backgrounded (the in-app alert
  // modal only fires while a page is open). Entirely optional and
  // gracefully absent when the backend has no VAPID keys configured —
  // pushConfig reports enabled:false and the enable button stays hidden.

  function urlBase64ToUint8Array_(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
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
        // has it (cheap, idempotent), and keep the button hidden.
        Api.savePushSubscription(existing.toJSON()).catch(() => {});
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

  // ---- Service worker update prompt ---------------------------------------
  //
  // service-worker.js calls self.skipWaiting() on install and clients.claim()
  // on activate, so a new deploy takes over almost immediately rather than
  // waiting for every tab to fully close first — but that means the CURRENT
  // page's already-loaded JS/CSS can end up mismatched with whatever the now-
  // active worker would serve on the next request. `controllerchange` fires
  // the moment a new worker takes control; this asks before reloading (never
  // silently) so a staffer isn't interrupted mid-scorecard, and only for a
  // REAL update — the first-ever install of the service worker also fires
  // this same event, which must NOT prompt (there's nothing to "update" yet).
  function initUpdatePrompt_() {
    if (!("serviceWorker" in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading || !hadController) return;
      reloading = true;
      confirmDialog({
        title: "Update available",
        message: "A new version of this app is ready. Refresh to use it? Any unsaved changes on this page won't be affected — writes are saved as you make them.",
        confirmLabel: "Refresh",
        cancelLabel: "Later",
        danger: false
      }).then((ok) => {
        if (ok) window.location.reload();
        else reloading = false; // let a LATER real update prompt again
      });
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
  function currentAndNextScheduleItems(rows, flights) {
    const flightList = Array.isArray(flights) ? flights : [];
    const isAllowed = (row) => flightMatchesAudience_(flightList, row.Flight);

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

  // ---- Black flag banner + announcements bell (global, every page) ----

  /**
   * Every page except Overview shows a compact pill in the header (see
   * #black-flag-pill in renderHeader). Overview used to get its own
   * full-width banner instead, rendered here independently of the
   * page's own content — but that ran on a totally separate pipeline
   * from Overview's own Roster/Schedule/weather loads, so it could pop
   * in before or after the rest of the page finished assembling.
   * Overview now renders the black flag status itself, inline in its
   * weather card, gated behind the SAME "everything's ready" check as
   * the rest of that page (see pages/overview.html) — so it no longer
   * needs a banner (or pill) from here at all.
   */
  function renderBlackFlagBanner_(status) {
    const active = !!(status && (status.Active === true || status.Active === "TRUE" || status.Active === "true"));
    const pill = document.getElementById("black-flag-pill");
    if (pill) pill.style.display = (active && activePage_ !== "overview") ? "inline-flex" : "none";
  }

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
  // Merges three otherwise-separate sources — Announcements, the
  // current Black Flag status, and Notes addressed to me — into one
  // reverse-chronological feed and one unseen-count badge, so "check
  // what's new" is one place instead of three. Kept up to date by
  // loadGlobalAlerts_'s three subscriptions below; the popover (see
  // toggleAnnouncementsPopover_) reads from these same cached arrays
  // instead of re-fetching.

  let lastAnnouncementRows_ = [];
  let lastBlackFlagStatus_ = null;
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
    if (lastBlackFlagStatus_) {
      const active = isBlackFlagActiveClient_(lastBlackFlagStatus_);
      // Black Flag has no history of past toggles, only the CURRENT
      // status — so this can only ever contribute its one latest
      // change, not a full log of every activation/lift like the other
      // two sources have.
      entries.push({
        type: "blackflag", icon: "⚑", timestamp: lastBlackFlagStatus_.UpdatedAt,
        title: active ? "Black Flag Activated" : "Black Flag Lifted",
        body: active ? "Outdoor activity is restricted." : `Restrictions lifted${lastBlackFlagStatus_.UpdatedBy ? ` by ${lastBlackFlagStatus_.UpdatedBy}` : ""}.`
      });
    }
    return entries
      .filter(e => e.timestamp && !isNaN(new Date(e.timestamp).getTime()))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  function isBlackFlagActiveClient_(status) {
    return !!(status.Active === true || status.Active === "TRUE" || status.Active === "true" || status.Active === "1" || status.Active === 1);
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
   * merged, reverse-chronological feed of Announcements, the current
   * Black Flag status, and Notes sent to me (see
   * mergedNotificationEntries_). Reads from the SAME cached arrays
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
    // widths, grows when the black-flag pill is showing), and a fixed
    // offset was overlapping the header buttons instead of sitting
    // below them.
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
    const blackFlagCache = Api.getSheetCached("BlackFlagStatus", (data) => {
      const status = (data.rows || [])[0] || null;
      lastBlackFlagStatus_ = status;
      renderBlackFlagBanner_(status);
      updateAnnouncementsBadge_();
      refreshOpenNotificationsPopover_();
      checkBlackFlagChange_(status);
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
    if (blackFlagCache.data) {
      const status = (blackFlagCache.data.rows || [])[0] || null;
      lastBlackFlagStatus_ = status;
      renderBlackFlagBanner_(status);
      checkBlackFlagChange_(status);
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
    return Promise.all([announcementsCache.ready, blackFlagCache.ready, notesCache.ready]).catch(() => {});
  }

  function showToast(message, { type = "" } = {}) {
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

  // ---- Custom tooltip (replaces native title="") ------------------------

  let tooltipEl_ = null;
  function ensureTooltipEl_() {
    if (!tooltipEl_) {
      tooltipEl_ = document.createElement("div");
      tooltipEl_.className = "tooltip-bubble";
      document.body.appendChild(tooltipEl_);
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
      label.textContent = opt ? opt.textContent : "Select…";
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
      row.textContent = opt.textContent;
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
      document.getElementById("modal-confirm-btn").focus();
    });
  }

  /**
   * Single-button informational modal — for content that's purely "here's
   * some information, acknowledge it" (e.g. the iOS install instructions),
   * where Shell.confirm()'s yes/no framing (and boolean return value)
   * wouldn't make sense. Reuses the same themed .modal-card/.modal-overlay
   * as confirmDialog. bodyHtml is trusted markup from this file, not user
   * input — callers must escape any dynamic values themselves before
   * interpolating them in.
   */
  function showInfoModal_({ title = "", bodyHtml = "", closeLabel = "Got it" } = {}) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="info-modal-title">
        <div class="modal-card__icon modal-card__icon--info">i</div>
        <h3 id="info-modal-title">${title}</h3>
        <div class="modal-card__body">${bodyHtml}</div>
        <div class="modal-card__actions">
          <button class="btn btn--primary" id="info-modal-close-btn">${closeLabel}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const releaseFocus = trapFocus_(overlay);

    const close = () => {
      document.removeEventListener("keydown", onKeydown);
      releaseFocus();
      overlay.remove();
    };
    const onKeydown = (e) => { if (e.key === "Escape" || e.key === "Enter") close(); };
    document.addEventListener("keydown", onKeydown);

    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.getElementById("info-modal-close-btn").addEventListener("click", close);
    document.getElementById("info-modal-close-btn").focus();
  }

  // ---- Blocking "new alert" popup (announcements / black flag) ---------

  let alertModalQueue_ = [];
  let alertModalShowing_ = false;

  /**
   * Full-screen, blurred, non-dismissible-except-by-button popup for a
   * genuinely NEW announcement or black flag change (see
   * checkNewAnnouncements_/checkBlackFlagChange_ below) — deliberately
   * has no outside-click or Escape close, unlike Shell.confirm(), since
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
    document.getElementById("alert-modal-dismiss-btn").focus();
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

  /**
   * Same idea as checkNewAnnouncements_ but for BlackFlagStatus, which
   * is a single row rather than a growing list — a "signature" of
   * Active+UpdatedAt is what changing means a new alert-worthy change
   * happened (either direction: activated or lifted).
   */
  function checkBlackFlagChange_(status) {
    if (!status) return;
    const active = isBlackFlagActiveClient_(status);
    const signature = `${active}|${status.UpdatedAt || ""}`;
    const key = positionScopedKey_(LAST_KNOWN_BLACKFLAG_SIGNATURE_KEY_PREFIX);
    const lastSignature = localStorage.getItem(key);
    const isFirstRun = lastSignature === null;

    if (!isFirstRun && lastSignature !== signature) {
      enqueueAlertModal_({
        icon: "⚑",
        danger: active,
        title: active ? "Black Flag Activated" : "Black Flag Lifted",
        bodyHtml: active
          ? "Outdoor activity is now restricted."
          : `Outdoor activity restrictions have been lifted${status.UpdatedBy ? ` (by ${escapeHtml_(status.UpdatedBy)})` : ""}.`
      });
    }
    localStorage.setItem(key, signature);
  }

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
   * Call once per page. Pass { activePage: 'schedule' | 'roster' | ... , requireAuth: true }
   */
  function init({ activePage = null, requireAuth = true } = {}) {
    activePage_ = activePage;
    if (requireAuth) Auth.requireSession();
    if (requireAuth && activePage) requirePageAccess(activePage);
    injectSkipLink_();
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
    // Global search keyboard shortcut (⌘/Ctrl-K), available on every page.
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
    }

    move();
    window.addEventListener("resize", move);
    return { move };
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
    isScheduleRowToday: isScheduleRowToday_, todayIso: todayIso_,
    formatDateTime: formatDateTime_, formatTime: formatTime_,
    animateIn, enhanceTabs
  };
})();
