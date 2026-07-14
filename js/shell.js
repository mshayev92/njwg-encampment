/* ============================================================
   NJWG ENCAMPMENT — APP SHELL RENDERER
   Builds the header, nav rail, duty status strip, black flag banner,
   and announcements bell. Every page includes a skeleton like:

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
    refresh:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 15.3-6.4L21 8M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16M3 21v-5h5"/></svg>'
  };

  const ANNOUNCEMENTS_SEEN_KEY = "njwg_announcements_last_seen_at";

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
        <div class="nav-rail__crest-mark"><img src="${window.APP_BASE_PATH}icons/icon-192.png" alt="${window.APP_CONFIG.UNIT_SHORT}"></div>
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
          <span id="sync-indicator" class="sync-indicator" style="display:none;">
            <span class="sync-indicator__dot"></span>
            <span id="sync-indicator__label"></span>
          </span>
          <button class="btn btn--ghost" id="hard-refresh-btn" data-tooltip="Refresh all data now" style="padding: var(--space-2);" aria-label="Refresh">
            <span style="width:16px;height:16px;display:inline-flex;">${ICONS.refresh}</span>
          </button>
          <button class="btn btn--ghost app-header__bell" id="announcements-bell-btn" style="position: relative; padding: var(--space-2);" data-tooltip="Announcements" aria-label="Announcements">
            <span style="width:18px;height:18px;display:inline-flex;">${ICONS.bell}</span>
            <span id="announcements-badge" style="display:none; position:absolute; top:2px; right:2px; background:var(--red-600); color:#fff; border-radius:999px; font-size:10px; line-height:1; padding:3px 5px; font-family:var(--font-mono);"></span>
          </button>
          <strong>${session.Position || session.position || "Staff"}</strong>
          <button class="btn btn--ghost" id="logout-btn" style="padding: var(--space-1) var(--space-3); font-size: var(--fs-xs);">Log out</button>
        ` : ""}
      </div>
    `;

    const logoutBtn = document.getElementById("logout-btn");
    if (logoutBtn) logoutBtn.addEventListener("click", () => Auth.logout());

    const bellBtn = document.getElementById("announcements-bell-btn");
    if (bellBtn) {
      bellBtn.addEventListener("click", () => {
        markAnnouncementsSeen_();
        const allowed = getAllowedNavItems();
        const hasAnnouncementsPage = allowed.some(i => i.id === "announcements");
        if (hasAnnouncementsPage) {
          window.location.href = `${window.APP_BASE_PATH}pages/announcements.html`;
        } else {
          toggleAnnouncementsPopover_();
        }
      });
    }

    const hardRefreshBtn = document.getElementById("hard-refresh-btn");
    if (hardRefreshBtn) {
      hardRefreshBtn.addEventListener("click", () => hardRefresh());
    }

    wireSyncIndicator_();
    wireTooltips_(header);
  }

  // ---- Sync status indicator (header) ----

  function wireSyncIndicator_() {
    const el = document.getElementById("sync-indicator");
    const label = document.getElementById("sync-indicator__label");
    if (!el || !label) return;

    Api.onSyncStatusChange((status, pending) => {
      el.classList.remove("sync-indicator--syncing", "sync-indicator--synced", "sync-indicator--error");
      if (status === "idle") {
        el.style.display = "none";
        return;
      }
      el.style.display = "inline-flex";
      if (status === "syncing") {
        el.classList.add("sync-indicator--syncing");
        label.textContent = pending > 1 ? `Saving ${pending}…` : "Saving…";
      } else if (status === "synced") {
        el.classList.add("sync-indicator--synced");
        label.textContent = "Saved";
      } else if (status === "error") {
        el.classList.add("sync-indicator--error");
        label.textContent = "Sync failed — tap Refresh";
      }
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

  async function hardRefresh() {
    const btn = document.getElementById("hard-refresh-btn");
    if (btn) btn.classList.add("is-spinning");
    try {
      await Api.hardRefresh();
      if (pageRefreshFn_) {
        await pageRefreshFn_();
      } else {
        window.location.reload();
      }
      loadGlobalAlerts_();
    } finally {
      if (btn) btn.classList.remove("is-spinning");
    }
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

  // ---- Black flag banner + announcements bell (global, every page) ----

  function ensureGlobalBannerSlot_() {
    let el = document.getElementById("black-flag-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "black-flag-banner";
      el.style.cssText = "display:none; background: var(--indigo-950); color:#fff; padding: var(--space-3) var(--space-5); text-align:center; font-family: var(--font-display); letter-spacing: var(--tracking-wide); text-transform: uppercase; font-size: var(--fs-sm); border-bottom: 3px solid #000;";
      const shell = document.querySelector(".app-shell");
      if (shell) shell.parentNode.insertBefore(el, shell);
      else document.body.insertBefore(el, document.body.firstChild);
    }
    return el;
  }

  function renderBlackFlagBanner_(status) {
    const el = ensureGlobalBannerSlot_();
    if (status && (status.Active === true || status.Active === "TRUE" || status.Active === "true")) {
      el.style.display = "block";
      el.style.background = "#000";
      el.textContent = "⚑ BLACK FLAG IN EFFECT — outdoor activity restricted";
    } else {
      el.style.display = "none";
    }
  }

  function getAnnouncementsLastSeen_() {
    return Number(localStorage.getItem(ANNOUNCEMENTS_SEEN_KEY) || 0);
  }

  function markAnnouncementsSeen_() {
    localStorage.setItem(ANNOUNCEMENTS_SEEN_KEY, String(Date.now()));
    const badge = document.getElementById("announcements-badge");
    if (badge) badge.style.display = "none";
  }

  function updateAnnouncementsBadge_(announcements) {
    const badge = document.getElementById("announcements-badge");
    if (!badge) return;
    const lastSeen = getAnnouncementsLastSeen_();
    const unseenCount = announcements.filter(a => {
      const t = new Date(a.Timestamp).getTime();
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
  function toggleAnnouncementsPopover_() {
    if (announcementsPopoverEl_) {
      announcementsPopoverEl_.remove();
      announcementsPopoverEl_ = null;
      return;
    }
    fetchAnnouncements_().then(announcements => {
      const el = document.createElement("div");
      el.style.cssText = "position:fixed; top:60px; right:16px; width:320px; max-width:90vw; max-height:70vh; overflow-y:auto; background:var(--surface); border:1px solid var(--line); border-radius:var(--radius-lg); box-shadow:var(--shadow-lg); padding:var(--space-4); z-index:1000;";
      const sorted = announcements.slice().sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp));
      el.innerHTML = sorted.length ? sorted.map(a => `
        <div style="padding: var(--space-3) 0; border-bottom: 1px solid var(--line);">
          <div style="font-size: var(--fs-2xs); color: var(--ink-600); text-transform:uppercase; letter-spacing:var(--tracking-wide); margin-bottom: var(--space-1);">${a.Position || "—"} · ${new Date(a.Timestamp).toLocaleString()}</div>
          <div style="font-size: var(--fs-sm); color: var(--ink-900);">${a.Message || ""}</div>
        </div>
      `).join("") : `<div style="color:var(--ink-600); font-size:var(--fs-sm);">No announcements yet.</div>`;
      document.body.appendChild(el);
      announcementsPopoverEl_ = el;
    });
  }

  async function fetchAnnouncements_() {
    try {
      const data = await Api.getSheet("Announcements");
      return data.rows || [];
    } catch (err) {
      return [];
    }
  }

  async function fetchBlackFlagStatus_() {
    try {
      const data = await Api.getSheet("BlackFlagStatus");
      return (data.rows || [])[0] || null;
    } catch (err) {
      return null;
    }
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
      updateAnnouncementsBadge_(data.rows || []);
    });
    const blackFlagCache = Api.getSheetCached("BlackFlagStatus", (data) => {
      renderBlackFlagBanner_((data.rows || [])[0] || null);
    });

    if (announcementsCache.data) updateAnnouncementsBadge_(announcementsCache.data.rows || []);
    if (blackFlagCache.data) renderBlackFlagBanner_((blackFlagCache.data.rows || [])[0] || null);

    // Always let the background fetches land too, even with no cache —
    // this covers the very first load, where getSheetCached() returned
    // null data but still kicked off the real request via `ready`.
    return Promise.all([announcementsCache.ready, blackFlagCache.ready]).catch(() => {});
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

  // ---- Custom modal (replaces native confirm()) -------------------------

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

      const cleanup = (result) => {
        overlay.remove();
        document.removeEventListener("keydown", onKeydown);
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
   * Call once per page. Pass { activePage: 'schedule' | 'roster' | ... , requireAuth: true }
   */
  function init({ activePage = null, requireAuth = true } = {}) {
    if (requireAuth) Auth.requireSession();
    if (requireAuth && activePage) requirePageAccess(activePage);
    renderNav(activePage);
    renderHeader();
    renderDutyStrip();
    wireTooltips_(document);
    if (requireAuth) {
      wireIdleTimeout();
      loadGlobalAlerts_();
      // Keep the banner/badge reasonably fresh without a full reload.
      setInterval(loadGlobalAlerts_, 2 * 60 * 1000);
    }
  }

  return {
    init, showToast, encampmentDayInfo, requirePageAccess, getAllowedNavItems,
    markAnnouncementsSeen: markAnnouncementsSeen_, refreshGlobalAlerts: loadGlobalAlerts_,
    confirm: confirmDialog, wireTooltips: wireTooltips_, registerRefresh, hardRefresh
  };
})();
