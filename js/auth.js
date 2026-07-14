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

   2. PER-PERSON SESSION (CAP ID) — stored in sessionStorage, so it
      does NOT persist across a full browser close, and additionally
      auto-clears after a period of inactivity (see idle timer below).
      This is the layer that identifies a specific person and their
      role, so it intentionally does not linger the way the device
      gate does — that keeps a shared device from staying "logged in
      as the last person" indefinitely.

   SECURITY NOTE: this module manages the CLIENT side of both layers
   only (storing/reading tokens). The actual authentication check
   happens server-side in apps-script/Code.gs, which verifies every
   token's signature and expiry on every single call. Nothing here is
   the security boundary — a user with dev tools open can always see
   or edit local/sessionStorage. That's expected and fine, because the
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

  // ---- Per-person session (Layer 2) ----------------------------------

  function getSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
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
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, ...member }));
    touchActivity();
  }

  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  /**
   * Call at the top of every protected page's <script>. Requires BOTH
   * the device gate and a per-person session; redirects to whichever
   * layer is missing, device gate first since it's the outer layer.
   */
  function requireSession() {
    requireDeviceGate();

    enforceIdleTimeout();

    const session = getSession();
    if (!session || !session.token) {
      const returnTo = encodeURIComponent(window.location.pathname);
      window.location.href = `${window.APP_BASE_PATH}index.html?returnTo=${returnTo}`;
      throw new Error("No session — redirecting to login.");
    }
    return session;
  }

  /**
   * Runs the CAP ID login flow. The Apps Script backend looks up the
   * CAP ID in Roster and, if found, returns a signed session token.
   * Requires the device gate to already be unlocked (Api.login sends
   * the device token automatically).
   */
  async function login(capId) {
    const trimmed = (capId || "").trim();
    if (!trimmed) throw new Error("Enter your CAP ID.");

    const data = await Api.login(trimmed);
    if (!data.token || !data.member) throw new Error("Sign-in failed. Try again.");

    setSession({ token: data.token, member: data.member });
    return data.member;
  }

  function logout() {
    clearSession();
    window.location.href = `${window.APP_BASE_PATH}index.html`;
  }

  /**
   * Convenience check for showing/hiding write-capable UI (e.g. an
   * "Edit schedule" button). This is a UX nicety only — the backend
   * enforces the real permission check on every write regardless of
   * what the page shows, so hiding a button here is not the security
   * boundary.
   */
  function isStaff() {
    const session = getSession();
    return !!session && session.Role === "Staff";
  }

  // ---- Idle timeout (auto-logout on the per-person session only) -----

  function touchActivity() {
    localStorage.setItem(IDLE_LAST_ACTIVE_KEY, String(Date.now()));
  }

  /**
   * If more time than IDLE_TIMEOUT_MS has passed since the last recorded
   * activity, clears the per-person session (NOT the device gate — the
   * device stays unlocked, only "who's using it right now" resets).
   * Call on every page load; also wired to periodic checks + activity
   * listeners in Shell.init so a page left open eventually logs out too.
   */
  function enforceIdleTimeout() {
    const last = Number(localStorage.getItem(IDLE_LAST_ACTIVE_KEY) || 0);
    if (last && Date.now() - last > IDLE_TIMEOUT_MS) {
      clearSession();
    }
    touchActivity();
  }

  return {
    // device gate
    getDeviceAuth, getDeviceToken, requireDeviceGate, unlockDevice, clearDeviceAuth,
    // per-person session
    getSession, getToken, setSession, clearSession, requireSession, login, logout, isStaff,
    // idle
    touchActivity, enforceIdleTimeout
  };
})();
