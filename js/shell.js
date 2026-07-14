/* ============================================================
   NJWG CAP ENCAMPMENT — APP SHELL RENDERER
   Builds the header, nav rail, and duty status strip.
   Every page includes a skeleton like:

     <div class="app-shell">
       <nav class="nav-rail" id="nav-rail"></nav>
       <header class="app-header" id="app-header"></header>
       <div class="duty-strip" id="duty-strip"></div>
       <main class="app-main">...page content...</main>
     </div>
     <script src="js/config.js"></script>   (or "../js/config.js" from pages/)
     <script src="js/api.js"></script>
     <script src="js/auth.js"></script>
     <script src="js/shell.js"></script>
     <script>Shell.init({ activePage: 'schedule' }); </script>

   PAGE ACCESS:
   Every page is gated — there is no always-allowed page anymore,
   including Roster. Each signed-in position's session carries a Pages
   array (from the StaffAccess sheet tab) listing exactly which nav
   items it's allowed to see. A position with an empty Pages list can
   sign in but sees no feature pages at all.
   ============================================================ */

const Shell = (() => {
  const ICONS = {
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    users:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    file:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    check:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>'
  };

  /** Returns the list of NAV_ITEMS ids this session is allowed to see. */
  function getAllowedPageIds() {
    const session = Auth.getSession();
    const pages = (session && Array.isArray(session.Pages)) ? session.Pages : [];
    return new Set(pages.map((p) => String(p).toLowerCase()));
  }

  /**
   * Returns the list of NAV_ITEMS this session is allowed to see. No
   * page is automatic anymore — a position must have its id explicitly
   * listed in StaffAccess Pages, including "roster".
   */
  function getAllowedNavItems() {
    const allowedSet = getAllowedPageIds();
    return window.APP_CONFIG.NAV_ITEMS.filter((item) => allowedSet.has(item.id.toLowerCase()));
  }

  function renderNav(activePage) {
    const rail = document.getElementById("nav-rail");
    if (!rail) return;

    const links = getAllowedNavItems().map(item => `
      <a class="nav-rail__link" href="${window.APP_BASE_PATH}${item.href}" ${item.id === activePage ? 'aria-current="page"' : ''}>
        <span class="nav-rail__link-icon">${ICONS[item.icon] || ""}</span>
        <span class="nav-rail__link-label">${item.label}</span>
      </a>
    `).join("");

    rail.innerHTML = `
      <div class="nav-rail__crest">
        <div class="nav-rail__crest-mark">${window.APP_CONFIG.UNIT_SHORT}</div>
        <div class="nav-rail__crest-text">${window.APP_CONFIG.UNIT_NAME}</div>
      </div>
      ${links}
    `;
  }

  function renderHeader() {
    const header = document.getElementById("app-header");
    if (!header) return;

    const session = Auth.getSession();
    header.innerHTML = `
      <h1 class="app-header__title">${window.APP_CONFIG.UNIT_NAME}</h1>
      <div class="app-header__user">
        ${session ? `
          <strong>${session.Position || session.position || "Staff"}</strong>
          <button class="btn btn--ghost" id="logout-btn" style="padding: var(--space-1) var(--space-3); font-size: var(--fs-xs);">Log out</button>
        ` : ""}
      </div>
    `;

    const logoutBtn = document.getElementById("logout-btn");
    if (logoutBtn) logoutBtn.addEventListener("click", () => Auth.logout());
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
    return { label: `DAY ${dayNumber} OF ${totalDays}`, isActive: true };
  }

  function renderDutyStrip() {
    const strip = document.getElementById("duty-strip");
    if (!strip) return;

    const { label } = encampmentDayInfo();
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const dateStr = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

    strip.innerHTML = `
      <span class="duty-strip__day">${label}</span>
      <span class="duty-strip__divider"></span>
      <span class="duty-strip__now-label">Today</span>
      <span class="duty-strip__now-value">${dateStr}</span>
      <span class="duty-strip__divider"></span>
      <span class="duty-strip__now-label">Local Time</span>
      <span class="duty-strip__now-value" id="duty-strip-clock">${timeStr}</span>
    `;

    setInterval(() => {
      const clock = document.getElementById("duty-strip-clock");
      if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }, 15000);
  }

  function showToast(message, { type = "" } = {}) {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = `toast ${type ? `toast--${type}` : ""}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 4000);
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
   * page id is exempt anymore — including 'roster'. Redirects to the
   * first page this position IS allowed to see (or back to login if
   * none) if access is denied, closing the gap where someone could
   * type a page's URL directly even though it's hidden from their nav.
   * This is a client-side UX guard, not the real security boundary —
   * Code.gs independently enforces its own read/write permission
   * checks regardless of what any page does.
   */
  function requirePageAccess(pageId) {
    const allowedSet = getAllowedPageIds();
    if (pageId && allowedSet.has(pageId.toLowerCase())) return true;

    showToast("You don't have access to that page.", { type: "error" });

    const allowedItems = getAllowedNavItems();
    if (allowedItems.length > 0) {
      window.location.href = `${window.APP_BASE_PATH}${allowedItems[0].href}`;
    } else {
      // This position has no pages at all — nothing to redirect to but
      // login (which will just bounce them right back if they retry).
      window.location.href = `${window.APP_BASE_PATH}index.html`;
    }
    throw new Error("Page access denied — redirecting.");
  }

  /**
   * Call once per page. Pass { activePage: 'schedule' | 'roster' | ... , requireAuth: true }
   */
  function init({ activePage = null, requireAuth = true } = {}) {
    if (requireAuth) Auth.requireSession();
    if (requireAuth && activePage) requirePageAccess(activePage);
    renderNav(activePage);
    renderHeader();
    renderDutyStrip();
    if (requireAuth) wireIdleTimeout();
  }

  return { init, showToast, encampmentDayInfo, requirePageAccess, getAllowedNavItems };
})();