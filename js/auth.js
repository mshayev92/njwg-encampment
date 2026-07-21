/* ============================================================
   NJWG CAP ENCAMPMENT — AUTH (TWO-LAYER GATE)
   Every protected page loads this after config.js and api.js,
   then calls Auth.requireSession() at the top of its own script.

   TWO LAYERS, TWO STORAGE LOCATIONS, ON PURPOSE:

   1. DEVICE GATE (passphrase) — stored in localStorage, because it's
      meant to persist across browser restarts/PWA relaunches on a
      device that's already been verified. Lifetime depends on whether
      the person marked the device "personal" or "shared" at gate time
      (see js/config.js DEVICE_GATE settings) — enforced server-side,
      not just here.

   2. PER-POSITION SESSION — stored in localStorage (same durability as
      the device gate), so it survives a full browser/PWA close and a
      device that's already signed in can keep working — including
      fully offline — after being relaunched, instead of landing back on
      the login screen every time. This app has no per-person login:
      instead of a CAPID, the user picks a POSITION (a flight, a
      squadron, "CCT", or "Administrator") from a dropdown populated
      from the StaffAccess sheet tab. CCT and Administrator each require
      their own separate password; ordinary flights/squadrons don't.
      "Signed in as that position indefinitely on a shared device" is
      bounded by the SAME idle timer this module already ran against
      sessionStorage (see enforceIdleTimeout below, backed by
      IDLE_LAST_ACTIVE_KEY in localStorage) — that timer is what
      actually enforces the "don't stay signed in forever" property, so
      moving the session itself to localStorage doesn't weaken it, it
      just stops closing the app from ALSO acting as a second, more
      aggressive logout on top of the idle timer.
      PREVIOUSLY this lived in sessionStorage, which cleared on every
      browser/tab close — that meant a device that was already signed
      in still couldn't resume its session (or reach any of the
      service-worker's precached pages) after being closed and reopened
      offline, since re-establishing a session always requires a live
      network round trip to the Worker (both to list positions and to
      issue a new session token). See offline.html / service-worker.js
      for the rest of the offline story; this is the piece that made a
      cold, offline relaunch dead-end at the login screen even on a
      device that had already signed in while online.

   SECURITY NOTE: this module manages the CLIENT side of both layers
   only (storing/reading tokens). The actual authentication check
   happens server-side in the Cloudflare Worker (worker/src/auth.js),
   which verifies every token's signature and expiry on every single
   call. Nothing here is
   the security boundary — a user with dev tools open can always see
   or edit localStorage. That's expected and fine, because the
   backend never trusts the client, only the signed token it verifies
   itself.
   ============================================================ */

const Auth = (() => {
  const SESSION_KEY = window.APP_CONFIG.SESSION_KEY;
  const DEVICE_KEY = window.APP_CONFIG.DEVICE_KEY;
  const IDLE_TIMEOUT_MS = window.APP_CONFIG.IDLE_TIMEOUT_MINUTES * 60 * 1000;
  const IDLE_LAST_ACTIVE_KEY = "njwg_last_active_at";

  // ---- Device gate (Layer 1) ----------------------------------------

  function getDeviceAuth() {
    try {
      const raw = localStorage.getItem(DEVICE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function getDeviceToken() {
    const device = getDeviceAuth();
    return device ? device.deviceToken : null;
  }

  function setDeviceAuth({ deviceToken, deviceType }) {
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ deviceToken, deviceType }));
  }

  function clearDeviceAuth() {
    localStorage.removeItem(DEVICE_KEY);
  }

  /**
   * Call at the top of the device-gate page. If no device token exists,
   * redirects to the passphrase gate. Does NOT verify expiry client-side
   * beyond basic presence — the backend is the real check, and will
   * reject an expired token on the next actual API call, at which point
   * js/api.js bounces back here automatically.
   */
  function requireDeviceGate() {
    const device = getDeviceAuth();
    if (!device || !device.deviceToken) {
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `${window.APP_BASE_PATH}gate.html?returnTo=${returnTo}`;
      throw new Error("No device gate — redirecting.");
    }
    return device;
  }

  /**
   * Submits the passphrase + device type to the backend. On success,
   * stores the returned device token in localStorage (long-lived) and
   * returns it. Throws on incorrect passphrase.
   */
  async function unlockDevice(passphrase, deviceType) {
    const trimmed = (passphrase || "").trim();
    if (!trimmed) throw new Error("Enter the passphrase.");

    const data = await Api.deviceLogin(trimmed, deviceType);
    if (!data.deviceToken) throw new Error("Unlock failed. Try again.");

    setDeviceAuth({ deviceToken: data.deviceToken, deviceType: data.deviceType });
    return data;
  }

  // ---- Per-position session (Layer 2) ----------------------------------

  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function getToken() {
    const session = getSession();
    return session ? session.token : null;
  }

  function setSession({ token, member }) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token, ...member }));
    touchActivity();
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    // A leftover sessionStorage entry from before the session moved to
    // localStorage would otherwise sit there harmlessly until the tab
    // closes — removed here too so a stale one from an old page version
    // can never be read by mistake.
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }

  /**
   * Call at the top of every protected page's <script>. Requires BOTH
   * the device gate and a per-position session; redirects to whichever
   * layer is missing, device gate first since it's the outer layer.
   */
  function requireSession() {
    requireDeviceGate();

    enforceIdleTimeout();

    const session = getSession();
    if (!session || !session.token) {
      // Must include the query string, not just the path — a deep link
      // like notes.html?subject=<cadet> (see Observations' "Start a
      // note" button) otherwise loses its subject the moment a session
      // redirect through login is involved, landing on a blank note
      // form instead of one pre-filled for that cadet.
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `${window.APP_BASE_PATH}index.html?returnTo=${returnTo}`;
      throw new Error("No session — redirecting to login.");
    }
    return session;
  }

  /**
   * Fetches the list of valid position names from the backend
   * (StaffAccess sheet tab), plus which of them require a password —
   * data-driven from whether that position's own Password cell is
   * filled in, not a hardcoded name list. Requires the device gate to
   * already be unlocked.
   */
  async function listPositions() {
    const data = await Api.listPositions();
    return { positions: data.positions || [], passwordProtected: data.passwordProtected || [] };
  }

  /**
   * Runs the position-based login flow. position must exactly match a
   * Position value in StaffAccess. password is required only for
   * password-protected positions (CCT, Administrator) — pass null/blank
   * for ordinary flights/squadrons. Requires the device gate to already
   * be unlocked (Api.login sends the device token automatically).
   */
  async function login(position, password) {
    const trimmedPosition = (position || "").trim();
    if (!trimmedPosition) throw new Error("Select a position.");

    const data = await Api.login(trimmedPosition, password || "");
    if (!data.token || !data.member) throw new Error("Sign-in failed. Try again.");

    setSession({ token: data.token, member: data.member });
    return data.member;
  }

  function logout() {
    clearSession();
    // The read cache now persists across page loads (see js/api.js) so
    // it survives navigation — but it must NOT survive a logout, or the
    // next person to sign in on this device would instantly render the
    // PREVIOUS position's cached Roster/Schedule/etc. before their own
    // session's read even lands.
    if (typeof Api !== "undefined" && Api.clearCache) Api.clearCache();
    window.location.href = `${window.APP_BASE_PATH}index.html`;
  }

  /**
   * Placeholder for future write-permission UI (e.g. an "Edit schedule"
   * button). StaffAccess no longer has a Role column — there is
   * currently no write-permission concept in the app at all, and no
   * page performs writes. If you add a write feature later and want
   * some positions to be able to write and others not, reintroduce a
   * permission signal here (e.g. a new StaffAccess column) and update
   * Code.gs's SHEET_PERMISSIONS accordingly. For now this always
   * returns false since nothing in the app currently checks it.
   */
  function isStaff() {
    return false;
  }

  // ---- Idle timeout (auto-logout on the per-position session only) -----

  function touchActivity() {
    localStorage.setItem(IDLE_LAST_ACTIVE_KEY, String(Date.now()));
  }

  /**
   * If more time than IDLE_TIMEOUT_MS has passed since the last recorded
   * activity, clears the per-position session (NOT the device gate — the
   * device stays unlocked, only "which position is using it right now"
   * resets). Call on every page load; also wired to periodic checks +
   * activity listeners in Shell.init so a page left open eventually logs
   * out too.
   */
  function enforceIdleTimeout() {
    const last = Number(localStorage.getItem(IDLE_LAST_ACTIVE_KEY) || 0);
    if (last && Date.now() - last > IDLE_TIMEOUT_MS) {
      clearSession();
      // Same reasoning as logout() — an idle-timed-out session shouldn't
      // leave its cached reads sitting around for whoever picks this
      // shared device up next.
      if (typeof Api !== "undefined" && Api.clearCache) Api.clearCache();
    }
    touchActivity();
  }

  return {
    // device gate
    getDeviceAuth, getDeviceToken, requireDeviceGate, unlockDevice, clearDeviceAuth,
    // per-position session
    getSession, getToken, setSession, clearSession, requireSession, listPositions, login, logout, isStaff,
    // idle
    touchActivity, enforceIdleTimeout
  };
})();
