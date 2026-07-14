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
    refresh:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 15.3-6.4L21 8M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16M3 21v-5h5"/></svg>'
  };

  const ANNOUNCEMENTS_SEEN_KEY = "njwg_announcements_last_seen_at";
  const NAV_COLLAPSED_KEY = "njwg_nav_collapsed";

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

  function isNavCollapsed_() {
    return localStorage.getItem(NAV_COLLAPSED_KEY) === "true";
  }

  function applyCollapsedState_(collapsed) {
    const shell = document.querySelector(".app-shell");
    if (shell) shell.classList.toggle("app-shell--collapsed", collapsed);
  }

  function toggleNavCollapsed_() {
    const collapsed = !isNavCollapsed_();
    localStorage.setItem(NAV_COLLAPSED_KEY, String(collapsed));
    applyCollapsedState_(collapsed);
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

    const session = Auth.getSession();

    rail.innerHTML = `
      <button type="button" class="nav-rail__crest" id="nav-rail-crest" aria-label="Toggle navigation width">
        <span class="nav-rail__crest-mark"><img src="${window.APP_BASE_PATH}icons/icon-192.png" alt="${window.APP_CONFIG.UNIT_SHORT}"></span>
        <span class="nav-rail__crest-text">${window.APP_CONFIG.UNIT_SHORT}<span>${window.APP_CONFIG.UNIT_NAME.replace(window.APP_CONFIG.UNIT_SHORT, "").trim() || "Encampment"}</span></span>
      </button>
      ${links}
      ${session ? `
        <div class="nav-rail__footer">
          <div class="nav-rail__footer-label">Signed in as</div>
          <div class="nav-rail__footer-position">${session.Position || session.position || "Staff"}</div>
          <button class="btn btn--ghost" id="logout-btn">Log out</button>
        </div>
      ` : ""}
    `;

    applyCollapsedState_(isNavCollapsed_());

    const crestBtn = document.getElementById("nav-rail-crest");
    if (crestBtn) crestBtn.addEventListener("click", toggleNavCollapsed_);

    const logoutBtn = document.getElementById("logout-btn");
    if (logoutBtn) logoutBtn.addEventListener("click", () => Auth.logout());
  }

  function renderHeader(activePage) {
    const header = document.getElementById("app-header");
    if (!header) return;

    const session = Auth.getSession();
    const navItem = (window.APP_CONFIG.NAV_ITEMS || []).find(i => i.id === activePage);
    const title = navItem ? navItem.label : window.APP_CONFIG.UNIT_NAME;

    header.innerHTML = `
      <h1 class="app-header__title">${title}</h1>
      <div class="app-header__user">
        ${session ? `
          <span id="black-flag-pill" class="black-flag-pill" style="display:none;">⚑ Black Flag</span>
          <span id="sync-indicator" class="sync-indicator sync-indicator--synced">
            <span class="sync-indicator__dot"></span>
            <span id="sync-indicator__label">Synced</span>
          </span>
          <button class="btn btn--ghost" id="hard-refresh-btn" data-tooltip="Refresh all data now" aria-label="Refresh">
            <span class="spinner spinner--sm btn__spinner" id="hard-refresh-spinner" style="display:none;"></span>
            <span id="hard-refresh-label">Refresh</span>
          </button>
          <button class="btn btn--ghost app-header__bell" id="announcements-bell-btn" style="position: relative; padding: var(--space-2);" data-tooltip="Announcements" aria-label="Announcements">
            <span style="width:18px;height:18px;display:inline-flex;">${ICONS.bell}</span>
            <span id="announcements-badge" style="display:none; position:absolute; top:2px; right:2px; background:var(--red-600); color:#fff; border-radius:999px; font-size:10px; line-height:1; padding:3px 5px; font-family:var(--font-mono);"></span>
          </button>
        ` : ""}
      </div>
    `;

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
    const spinner = document.getElementById("hard-refresh-spinner");
    const label = document.getElementById("hard-refresh-label");
    if (btn) { btn.disabled = true; btn.classList.add("is-spinning"); }
    if (spinner) spinner.style.display = "inline-block";
    if (label) label.textContent = "Refreshing…";
    try {
      await Api.hardRefresh();
      if (pageRefreshFn_) {
        await pageRefreshFn_();
      } else {
        window.location.reload();
      }
      loadGlobalAlerts_();
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove("is-spinning"); }
      if (spinner) spinner.style.display = "none";
      if (label) label.textContent = "Refresh";
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

  // ---- Black flag banner + announcements bell (global, every page) ----

  function ensureGlobalBannerSlot_() {
    let el = document.getElementById("black-flag-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "black-flag-banner";
      el.style.cssText = "display:none; align-items:center; gap: var(--space-3); background:#000; color:#fff; border-radius: var(--radius-lg); padding: var(--space-4) var(--space-5); margin-bottom: var(--space-4); font-family: var(--font-display); letter-spacing: var(--tracking-wide); text-transform: uppercase; font-size: var(--fs-sm);";
      const main = document.querySelector(".app-main");
      if (main) main.insertBefore(el, main.firstChild);
      else document.body.insertBefore(el, document.body.firstChild);
    }
    return el;
  }

  /**
   * Overview keeps the full-width banner exactly as designed; every
   * other page shows a compact pill in the header instead (see
   * #black-flag-pill in renderHeader) so the alert is still visible
   * without repeating the big banner on every screen.
   */
  function renderBlackFlagBanner_(status) {
    const active = !!(status && (status.Active === true || status.Active === "TRUE" || status.Active === "true"));

    if (activePage_ === "overview") {
      const el = ensureGlobalBannerSlot_();
      el.style.display = active ? "flex" : "none";
      el.textContent = "⚑ BLACK FLAG IN EFFECT — outdoor activity restricted";
    }

    const pill = document.getElementById("black-flag-pill");
    if (pill) pill.style.display = (active && activePage_ !== "overview") ? "inline-flex" : "none";
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
  let announcementsOutsideHandler_ = null;
  let announcementsKeyHandler_ = null;

  function renderAnnouncementsList_(announcements) {
    const sorted = announcements.slice().sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp));
    return sorted.length ? sorted.map(a => `
      <div class="announcements-popover__item">
        <div class="announcements-popover__meta">${a.Position || "—"} · ${new Date(a.Timestamp).toLocaleString()}</div>
        <div class="announcements-popover__message">${a.Message || ""}</div>
      </div>
    `).join("") : `<div class="announcements-popover__empty">No announcements yet.</div>`;
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
   * Opens (or, if already open, closes) the announcements popover.
   * Renders instantly from Api's persisted cache when warm — which it
   * normally is, since Shell.init() eagerly warms "Announcements" on
   * every page — then silently revalidates in the background. Closes
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
        <span>Announcements</span>
        <button type="button" class="announcements-popover__close" aria-label="Close">&times;</button>
      </div>
      <div class="announcements-popover__list">
        <div class="state-message" style="padding: var(--space-5);"><div class="spinner spinner--sm"></div></div>
      </div>
    `;
    document.body.appendChild(el);
    announcementsPopoverEl_ = el;

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

    const listEl = el.querySelector(".announcements-popover__list");
    const { data: cached, ready } = Api.getSheetCached("Announcements", (fresh) => {
      if (announcementsPopoverEl_ === el) listEl.innerHTML = renderAnnouncementsList_(fresh.rows || []);
    });
    if (cached) listEl.innerHTML = renderAnnouncementsList_(cached.rows || []);

    ready.catch(() => {
      if (announcementsPopoverEl_ === el && !cached) {
        listEl.innerHTML = `<div class="announcements-popover__empty">Couldn't load announcements.</div>`;
      }
    });
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

  // ---- Custom dropdown (replaces native <select>) -----------------------

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
      document.removeEventListener("click", onOutsideClick, true);
      document.removeEventListener("keydown", onKeydown);
    }

    function open() {
      wrap.classList.add("is-open");
      menu.style.display = "block";
      document.addEventListener("click", onOutsideClick, true);
      document.addEventListener("keydown", onKeydown);
    }

    function onOutsideClick(e) {
      if (!wrap.contains(e.target)) close();
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
    activePage_ = activePage;
    if (requireAuth) Auth.requireSession();
    if (requireAuth && activePage) requirePageAccess(activePage);
    renderNav(activePage);
    renderHeader(activePage);
    wireTooltips_(document);
    if (requireAuth) {
      wireIdleTimeout();
      loadGlobalAlerts_();
      // Keep the banner/badge reasonably fresh without a full reload.
      setInterval(loadGlobalAlerts_, 2 * 60 * 1000);
      // Warm every sheet ANY page reads from, not just this one — so by
      // the time someone clicks to another page, its data is already
      // sitting in the persisted cache and renders instantly instead of
      // making them wait on the network again.
      Api.warmCache(window.APP_CONFIG.PREFETCH_SHEETS || []);
      setInterval(() => Api.warmCache(window.APP_CONFIG.PREFETCH_SHEETS || []), 60 * 1000);
    }
  }

  return {
    init, showToast, encampmentDayInfo, requirePageAccess, getAllowedNavItems,
    markAnnouncementsSeen: markAnnouncementsSeen_, refreshGlobalAlerts: loadGlobalAlerts_,
    confirm: confirmDialog, wireTooltips: wireTooltips_, registerRefresh, hardRefresh,
    enhanceSelect, openContextMenu
  };
})();
